import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { createHmac } from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';

dotenv.config();

/**
 * Fastify Server voor de Media Service.
 * Schrijft en leest direct van S3 voor multi-instance ondersteuning.
 */
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 26 * 1024 * 1024 // 26MB limiet
});

// Configuratie vanuit Environment Variables (Terraform)
const config = {
  port: 8080,
  host: '0.0.0.0',
  region: process.env.AWS_REGION || 'eu-central-1',
  bucketName: process.env.S3_BUCKET, // Doorgegeven via module.storage
  signingSecret: process.env.MEDIA_SIGNING_SECRET || 'dev-secret'
};

// Initialiseer AWS S3 Client
const s3Client = new S3Client({ region: config.region });

await app.register(cors, { origin: true });
await app.register(sensible);

// Parser voor binaire afbeeldingen
app.addContentTypeParser(
  ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
  { parseAs: 'buffer' },
  async (req, body) => body
);

/**
 * Middleware: Controleert de HMAC handtekening.
 * Werkt voor zowel Headers (upload) als Query Params (browser weergave).
 */
async function verifyHmac(request, reply) {
  if (request.method === 'OPTIONS') return; 

  const signature = request.headers['x-signature'] || request.query.signature;
  const expiresStr = request.headers['x-expires'] || request.query.expires;
  
  if (!signature || !expiresStr) {
    return reply.code(403).send({ error: 'Forbidden: Missing signature' });
  }

  const expires = parseInt(expiresStr);
  if (Date.now() > expires) {
    return reply.code(403).send({ error: 'Forbidden: Signature expired' });
  }

  const method = request.method;
  // Pad opschonen voor verificatie (zonder /media prefix)
  const urlPath = request.url.split('?')[0].replace(/\/+/g, '/').replace(/^\/media/, '');
  
  const expected = createHmac('sha256', config.signingSecret)
    .update(`${method}:${urlPath}:${expires}`)
    .digest('hex');

  if (signature !== expected) {
    return reply.code(403).send({ error: 'Forbidden: Invalid signature' });
  }
}

// --- ROUTES ---

// Health check voor Terraform/ALB
app.get('/media/health', async () => ({ status: 'ok', storage: 's3' }));

/**
 * Sign Route: Wordt aangeroepen door de API Service om URLs te ondertekenen.
 */
app.post('/media/sign', async (request) => {
  const { method, path: reqPath, expiresIn = 300 } = request.body;
  const expires = Date.now() + (expiresIn * 1000);
  const cleanPath = `/${reqPath}`.replace(/\/+/g, '/');
  
  const signature = createHmac('sha256', config.signingSecret)
    .update(`${method}:${cleanPath}:${expires}`)
    .digest('hex');
  
  return { 
    url: cleanPath,
    headers: { 
      'X-Signature': signature, 
      'X-Expires': expires.toString()
    }
  };
});

/**
 * S3 Upload Handler (Originals & Processed)
 */
const handleS3Put = async (request, reply) => {
  const filepath = request.params['*'];
  const folder = request.url.includes('/processed/') ? 'processed' : 'originals';
  const key = `${folder}/${filepath}`;

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: request.body,
      ContentType: request.headers['content-type'] || 'image/jpeg'
    }));
    return { success: true, path: key };
  } catch (err) {
    app.log.error(`S3 Error: ${err.message}`);
    return reply.internalServerError('S3 Upload Failed');
  }
};

app.put('/media/originals/*', { preHandler: verifyHmac }, handleS3Put);
app.put('/media/processed/*', { preHandler: verifyHmac }, handleS3Put);

/**
 * S3 Download Handler
 */
const handleS3Get = async (request, reply) => {
  const filepath = request.params['*'];
  const folder = request.url.includes('/processed/') ? 'processed' : 'originals';
  const key = `${folder}/${filepath}`;

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key
    }));
    
    return reply
      .type(response.ContentType || 'image/jpeg')
      .send(response.Body);
  } catch (err) {
    return reply.notFound();
  }
};

app.get('/media/originals/*', { preHandler: verifyHmac }, handleS3Get);
app.get('/media/processed/*', { preHandler: verifyHmac }, handleS3Get);

/**
 * S3 Delete Handler
 */
app.delete('/media/originals/*', { preHandler: verifyHmac }, async (request) => {
  const key = `originals/${request.params['*']}`;
  await s3Client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
  return { success: true };
});

// Start de server
try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`Media Service draait op poort ${config.port} met S3 opslag.`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}