#!/bin/bash

echo "➡ Actualizando código desde Git..."
git pull origin main

echo "➡ Instalando dependencias (si hay nuevas)..."
npm install

echo "➡ Reiniciando PM2..."
pm2 restart duoclub-api

echo "➡ Guardando estado de PM2..."
pm2 save

echo "✅ Deploy terminado."
