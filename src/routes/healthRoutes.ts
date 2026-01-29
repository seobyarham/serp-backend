import { Router } from 'express';
import { HealthController } from '../controllers/healthController';

const router = Router();
const healthController = new HealthController();

// Basic health check
router.get('/', healthController.checkHealth);

// Detailed API key statistics
router.get('/keys', healthController.getApiKeyStats);

export { router as healthRoutes };