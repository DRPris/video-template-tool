import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { authenticate } from '../middleware/auth.js';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from '../controllers/template.controller.js';

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.upload.templatesDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `template_${uuidv4()}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB for templates
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
        const allowedExts = ['.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式，支持: PNG, JPG, JPEG, WebP'));
        }
    },
});

const router = Router();

router.use(authenticate);

router.get('/', listTemplates);
router.get('/:id', getTemplate);
router.post('/', upload.single('file'), createTemplate);
router.put('/:id', updateTemplate);
router.delete('/:id', deleteTemplate);

export default router;
