import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { createHash, randomUUID } from 'crypto';
import pg from 'pg';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  },
  bodyLimit: parseInt(process.env.MAX_UPLOAD_MB || '25') * 1024 * 1024
});

// Config
const config = {
  port: process.env.PORT || 8000,
  host: '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://pxlcensor:devpassword@localhost:5432/pxlcensor',
  mediaServiceUrl: process.env.MEDIA_SERVICE_URL,
  mediaExternalUrl: process.env.MEDIA_EXTERNAL_URL || process.env.MEDIA_SERVICE_URL,
  mediaSigningSecret: process.env.MEDIA_SIGNING_SECRET || 'dev-secret-change-in-production',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_MB || '25') * 1024 * 1024
};

// DEBUG: Log signing secret at startup (first 10 chars only)
console.log('=== API SERVICE STARTUP ===');
console.log('Media Service URL:', config.mediaServiceUrl);
console.log('Media External URL:', config.mediaExternalUrl);
console.log('Signing Secret (first 10 chars):', config.mediaSigningSecret.substring(0, 10) + '...');
console.log('===========================');

// Database connection
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 6000
});

// Register plugins
await app.register(cors, {
  origin: true,
  credentials: true
});
await app.register(sensible);

// Helper functions
function calculateSha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function generatePath(mime) {
  const ext = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }[mime] || 'jpg';
  
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const uuid = randomUUID();
  
  return `${year}/${month}/${uuid}.${ext}`;
}

async function getSignedUrl(method, path, expiresIn = 300) {
  // Clean the path - remove leading slashes and /media/ prefix for signing
  let cleanPath = path.replace(/^\/+/, '').replace(/^media\//, '');
  
  app.log.info('Getting signed URL', { method, path: cleanPath, expiresIn });
  
  const response = await fetch(`${config.mediaServiceUrl}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      method, 
      path: cleanPath,
      expiresIn 
    })
  });
  
  if (!response.ok) {
    throw new Error(`Sign endpoint failed: ${response.status}`);
  }
  
  const result = await response.json();
  
  app.log.debug('Signed URL result', { 
    url: result.url, 
    hasHeaders: !!result.headers 
  });
  
  return result;
}

app.get('/api/health', async () => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', service: 'api', database: 'connected' };
  } catch (err) {
    return { status: 'error', service: 'api', database: 'disconnected' };
  }
});

// Initialize upload
app.post('/api/upload-init', async (request) => {
  const { filename, mime, bytes, sha256, processing_options } = request.body;
  
  app.log.info('Upload init', { filename, mime, bytes, sha256 });
  
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedMimes.includes(mime)) {
    throw app.httpErrors.badRequest('Invalid file type');
  }
  
  if (bytes > config.maxUploadBytes) {
    throw app.httpErrors.badRequest(`File too large. Max size: ${config.maxUploadBytes} bytes`);
  }

  const defaultOptions = { method: 'mosaic', mosaic_size: 20 };
  const options = { ...defaultOptions, ...processing_options };
  
  const allowedMethods = ['blur', 'solid', 'none', 'mosaic'];
  if (!allowedMethods.includes(options.method)) {
    throw app.httpErrors.badRequest('Invalid processing method');
  }
  
  if (!Number.isInteger(options.mosaic_size) || options.mosaic_size < 1 || options.mosaic_size > 120) {
    throw app.httpErrors.badRequest('mosaic_size must be integer between 1-120');
  }
  
  // Check for duplicates
  const existing = await pool.query(
    'SELECT id, status, processed_path FROM images WHERE sha256 = $1',
    [sha256]
  );
  
  if (existing.rows.length > 0) {
    const image = existing.rows[0];
    app.log.info('Duplicate image found', { imageId: image.id });
    return {
      image_id: image.id,
      status: image.status,
      processed_path: image.processed_path,
      duplicate: true
    };
  }
  
  const originalPath = `originals/${generatePath(mime)}`;
  
  const result = await pool.query(
    `INSERT INTO images (original_path, sha256, mime, bytes, status, processing_options)
     VALUES ($1, $2, $3, $4, 'uploaded', $5)
     RETURNING id`,
    [originalPath, sha256, mime, bytes, JSON.stringify(options)]
  );
  
  const imageId = result.rows[0].id;
  
  await pool.query(
    'INSERT INTO events (image_id, type, data) VALUES ($1, $2, $3)',
    [imageId, 'uploaded', JSON.stringify({ mime, bytes })]
  );
  
  // Get signed URL for upload - use /media/ prefix since requests go through ALB
  const signed = await getSignedUrl('PUT', `/media/${originalPath}`);
  
  // Construct the full upload URL
  const baseUrl = config.mediaExternalUrl.replace(/\/$/, '');
  const signedPath = signed.url || '';
  const uploadUrl = `${baseUrl}${signedPath.startsWith('/') ? signedPath : '/' + signedPath}`;
  
  app.log.info('Upload URL created', { 
    imageId, 
    uploadUrl,
    hasHeaders: !!signed.headers 
  });
  
  return {
    image_id: imageId,
    upload_url: uploadUrl,
    upload_headers: signed.headers || {},
    original_path: originalPath
  };
});

// Process image
app.post('/api/images/:id/process', async (request) => {
  const imageId = request.params.id;
  const { pipeline = 'deface_boxes' } = request.body;
  
  const imageResult = await pool.query(
    'SELECT status, sha256, processing_options FROM images WHERE id = $1',
    [imageId]
  );
  
  if (imageResult.rows.length === 0) {
    throw app.httpErrors.notFound('Image not found');
  }
  
  const image = imageResult.rows[0];
  if (image.status === 'processing' || image.status === 'queued') {
    throw app.httpErrors.conflict('Already processing');
  }
  
  const dedupeKey = `${image.sha256}:${pipeline}`;
  const existingJob = await pool.query(
    'SELECT id FROM jobs WHERE dedupe_key = $1',
    [dedupeKey]
  );
  
  if (existingJob.rows.length > 0) {
    return { job_id: existingJob.rows[0].id, duplicate: true };
  }
  
  const jobResult = await pool.query(
    `INSERT INTO jobs (image_id, kind, status, dedupe_key, processing_options)
     VALUES ($1, $2, 'queued', $3, $4)
     RETURNING id`,
    [imageId, pipeline, dedupeKey, JSON.stringify(image.processing_options)]
  );
  
  const jobId = jobResult.rows[0].id;
  await pool.query("UPDATE images SET status = 'queued' WHERE id = $1", [imageId]);
  
  return { job_id: jobId };
});

// List images
app.get('/api/images', async (request) => {
  const { status, page = 1, pageSize = 20 } = request.query;
  const offset = (page - 1) * pageSize;
  
  let query = `SELECT id, mime, bytes, status, processed_path, created_at, updated_at FROM images`;
  const params = [];
  
  if (status) {
    query += ' WHERE status = $1';
    params.push(status);
  }
  
  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(pageSize, offset);
  
  const result = await pool.query(query, params);
  
  // Generate signed URLs for all processed images
  const baseUrl = config.mediaExternalUrl.replace(/\/$/, '');
  
  const images = await Promise.all(result.rows.map(async img => {
    let processedUrl = null;
    
    if (img.processed_path) {
      try {
        const signed = await getSignedUrl('GET', `/media/${img.processed_path}`, 3600); // 1 hour validity
        const signedPath = signed.url || '';
        
        // Construct base URL
        processedUrl = `${baseUrl}${signedPath.startsWith('/') ? signedPath : '/' + signedPath}`;
        
        // Add signature as query parameters (voor browser <img> tags)
        if (signed.headers && signed.headers['X-Signature'] && signed.headers['X-Expires']) {
          const params = new URLSearchParams();
          params.append('signature', signed.headers['X-Signature']);
          params.append('expires', signed.headers['X-Expires']);
          processedUrl += `?${params.toString()}`;
        }
      } catch (err) {
        app.log.warn('Failed to generate signed URL for processed image', { 
          path: img.processed_path, 
          error: err.message 
        });
      }
    }
    
    return {
      ...img,
      processed_url: processedUrl
    };
  }));
  
  return { images, page, pageSize };
});

// Get image details
app.get('/api/images/:id', async (request) => {
  const imageId = request.params.id;
  const result = await pool.query('SELECT * FROM images WHERE id = $1', [imageId]);
  
  if (result.rows.length === 0) throw app.httpErrors.notFound('Image not found');
  
  const image = result.rows[0];
  const events = await pool.query(
    'SELECT type, data, at FROM events WHERE image_id = $1 ORDER BY at DESC', 
    [imageId]
  );
  
  let originalUrl = null;
  let originalHeaders = null;
  if (image.original_path) {
    const signed = await getSignedUrl('GET', `/media/${image.original_path}`, 60);
    
    const baseUrl = config.mediaExternalUrl.replace(/\/$/, '');
    const signedPath = signed.url || '';
    originalUrl = `${baseUrl}${signedPath.startsWith('/') ? signedPath : '/' + signedPath}`;
    originalHeaders = signed.headers;
  }

  // Generate signed URL for processed image
  let processedUrl = null;
  let processedHeaders = null;
  if (image.processed_path) {
    const signed = await getSignedUrl('GET', `/media/${image.processed_path}`, 3600); // 1 hour validity
    
    const baseUrl = config.mediaExternalUrl.replace(/\/$/, '');
    const signedPath = signed.url || '';
    processedUrl = `${baseUrl}${signedPath.startsWith('/') ? signedPath : '/' + signedPath}`;
    processedHeaders = signed.headers;
    
    // Add signature as query parameters (voor browser <img> tags)
    if (signed.headers && signed.headers['X-Signature'] && signed.headers['X-Expires']) {
      const params = new URLSearchParams();
      params.append('signature', signed.headers['X-Signature']);
      params.append('expires', signed.headers['X-Expires']);
      processedUrl += `?${params.toString()}`;
    }
  }

  return {
    ...image,
    original_url: originalUrl,
    original_headers: originalHeaders,
    processed_url: processedUrl,
    processed_headers: processedHeaders,
    events: events.rows
  };
});

// Delete image
app.delete('/api/images/:id', async (request) => {
  const imageId = request.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const imageResult = await client.query(
      'SELECT original_path, processed_path FROM images WHERE id = $1', 
      [imageId]
    );
    if (imageResult.rows.length === 0) throw app.httpErrors.notFound('Image not found');
    
    const image = imageResult.rows[0];
    
    // TODO: Delete files from media service using signed DELETE requests
    // For now, just delete from database
    
    await client.query('DELETE FROM jobs WHERE image_id = $1', [imageId]);
    await client.query('DELETE FROM events WHERE image_id = $1', [imageId]);
    await client.query('DELETE FROM images WHERE id = $1', [imageId]);
    await client.query('COMMIT');
    
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Get job status
app.get('/api/jobs/:id', async (request) => {
  const jobId = request.params.id;
  const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (result.rows.length === 0) throw app.httpErrors.notFound('Job not found');
  return result.rows[0];
});

// Queue stats
app.get('/api/queue', async () => {
  const stats = await pool.query('SELECT * FROM get_queue_stats()');
  return { stats: stats.rows };
});

// Metrics endpoint
app.get('/api/metrics', async () => {
  const metrics = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM images) as total_images,
      (SELECT COUNT(*) FROM images WHERE status = 'done') as processed_images,
      (SELECT COUNT(*) FROM jobs WHERE status = 'queued') as queued_jobs
  `);
  return metrics.rows[0];
});

// Start server
try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`API service running on port ${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}