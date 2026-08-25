import { Router } from 'express';
import { getCustomers, getCustomerDetail } from '../controllers/customers.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/', getCustomers);
router.get('/:id', getCustomerDetail);

export default router;