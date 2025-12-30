#!/bin/sh
set -e

echo "Initializing pxlcensor database op $POSTGRES_HOST..."

# Voer de bestanden handmatig uit in de juiste volgorde
# Gebruik de variabelen die Terraform doorgeeft
psql "$DATABASE_URL" -f /app/001_init.sql
psql "$DATABASE_URL" -f /app/002_functions.sql
psql "$DATABASE_URL" -f /app/003_processing_options.sql

echo "Database initialization complete!"