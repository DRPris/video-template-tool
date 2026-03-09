import { Router } from 'express';
import { login, register, getMe, listUsers } from '../controllers/auth.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

router.post('/login', login);
router.post('/register', register);
router.get('/me', authenticate, getMe);
router.get('/users', authenticate, requireAdmin, listUsers);

export default router;
