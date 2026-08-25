import { Router } from 'express';
import { getKnowledgeBase, addKnowledgeItem, updateKnowledgeItem, deleteKnowledgeItem } from '../controllers/knowledge.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/', getKnowledgeBase);
router.post('/', addKnowledgeItem);
router.put('/:id', updateKnowledgeItem);
router.delete('/:id', deleteKnowledgeItem);

export default router;