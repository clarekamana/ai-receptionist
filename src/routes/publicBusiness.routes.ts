import { Router } from 'express';
import { listBusinesses, searchBusinesses, getBusinessPublic } from '../controllers/publicBusiness.controller';

// Public Mwakire business-discovery API for the customer app — deliberately
// no `authenticate` middleware. /search must be registered before /:id, or
// a request to /search would be swallowed by the /:id wildcard.
const router = Router();

router.get('/search', searchBusinesses);
router.get('/', listBusinesses);
router.get('/:id', getBusinessPublic);

export default router;
