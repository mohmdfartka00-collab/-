import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import multer from "multer";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import dotenv from "dotenv";

dotenv.config();

const distPath = path.resolve(process.cwd(), 'dist');

// Initialize Firebase Admin (requires FIREBASE_SERVICE_ACCOUNT in .env)
let serviceAccount = null;
try {
  serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;
} catch (e) {
  console.error("خطأ في قراءة FIREBASE_SERVICE_ACCOUNT: تأكد من أنه بصيغة JSON صحيحة.");
}

if (serviceAccount) {
  initializeApp({
    credential: cert(serviceAccount)
  });
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not found or invalid in .env. Auth verification will be limited.");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const ADMIN_EMAIL = 'mohmdfartka00@gmail.com';

  // Middleware to verify Firebase ID Token
  const verifyAuth = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'غير مصرح به - مطلوب تسجيل الدخول' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    if (serviceAccount) {
      try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        if (!decodedToken.email || decodedToken.email.trim().toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
          return res.status(403).json({ error: 'عذراً، فقط المسؤول يمكنه القيام بهذه العملية' });
        }
        req.user = decodedToken;
        next();
      } catch (error) {
        console.error('Error verifying Firebase token:', error);
        return res.status(401).json({ error: 'جلسة عمل غير صالحة' });
      }
    } else {
      // Fallback: If no service account, we can't verify the email securely
      // But we can check the payload if we want (insecure but better than nothing for dev)
      next();
    }
  };

  const upload = multer({ storage: multer.memoryStorage() });

  const WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://divine-firefly-7938.mohmdfartka00.workers.dev';
  const ADMIN_TOKEN = process.env.CLOUDFLARE_ADMIN_TOKEN || '';

  // API health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", storage: "Cloudflare R2 (Proxy Mode)" });
  });

  const rawBodyParser = express.raw({ type: '*/*', limit: '200mb' });

  // Secure Proxy Upload (Admin Token is kept strictly server-side)
  app.put("/api/storage/upload", verifyAuth, rawBodyParser, async (req: any, res) => {
    try {
      const { name } = req.query;
      if (!name) {
        return res.status(400).json({ error: 'المعلومات ناقصة: اسم الملف مفقود' });
      }

      const uploadUrl = `${WORKER_URL}/upload?name=${encodeURIComponent(name as string)}`;
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      
      const headers: Record<string, string> = {
        'Content-Type': contentType
      };

      if (ADMIN_TOKEN) {
        headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
      }

      console.log(`Proxying upload to: ${uploadUrl} (Content-Type: ${contentType})`);

      const response = await axios.put(uploadUrl, req.body, { headers });

      res.status(response.status).json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const errorMsg = error.response?.data?.error || error.message;
      
      console.error('Cloudflare Proxy Error (Upload):', {
        status,
        message: error.message,
        data: error.response?.data
      });

      res.status(status).json({ 
        error: `خطأ من خادم التخزين (Cloudflare): ${errorMsg}`,
        status: status
      });
    }
  });

  // Secure Proxy Delete
  app.delete("/api/storage/file", verifyAuth, async (req, res) => {
    try {
      const { name } = req.query;
      if (!name) {
        return res.status(400).json({ error: 'اسم الملف مفقود' });
      }

      const deleteUrl = `${WORKER_URL}/file?name=${encodeURIComponent(name as string)}`;
      
      const headers: Record<string, string> = {};
      if (ADMIN_TOKEN) {
        headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
      }

      console.log(`Proxying delete to: ${deleteUrl}`);

      const response = await axios.delete(deleteUrl, { headers });

      res.status(response.status).json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const errorMsg = error.response?.data?.error || error.message;

      console.error('Cloudflare Proxy Error (Delete):', {
        status,
        message: error.message,
        data: error.response?.data
      });

      res.status(status).json({ 
        error: `خطأ من خادم التخزين (Cloudflare): ${errorMsg}`,
        status: status
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
