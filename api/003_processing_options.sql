-- Add processing options to images table
ALTER TABLE images ADD COLUMN processing_options JSONB DEFAULT '{"method": "mosaic", "scale_720p": false, "mosaic_size": 20}';

-- Add processing options to jobs table for job-specific config
ALTER TABLE jobs ADD COLUMN processing_options JSONB DEFAULT '{}';