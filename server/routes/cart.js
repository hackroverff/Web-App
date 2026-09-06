/** Cart endpoints. Only product ids and quantities cross the wire. */
import express from 'express';
import { addItem, removeItem, setQty, clearCart, loadCart } from '../services/cart.js';
import { requireCustomer } from '../middleware/session.js';
import { badRequest } from '../lib/errors.js';
import { intIn } from '../lib/validate.js';

export const router = express.Router();
router.use(requireCustomer);

const pid = (raw) => {
  const n = intIn(raw, { field: 'product_id', min: 1, max: 1_000_000, fallback: 0 });
  if (!n) throw badRequest('product_id is required.');
  return n;
};

router.get('/', (req, res) => res.json(loadCart(req.user.id, req.user)));

router.post('/items', (req, res, next) => {
  try {
    const id = pid(req.body?.product_id);
    const qty = intIn(req.body?.qty, { field: 'qty', min: 1, max: 200, fallback: 1 });
    addItem(req.user.id, id, qty);
    res.json(loadCart(req.user.id, req.user));
  } catch (err) {
    next(err);
  }
});

router.patch('/items/:id', (req, res, next) => {
  try {
    const id = pid(req.params.id);
    const qty = intIn(req.body?.qty, { field: 'qty', min: 0, max: 999, fallback: 1 });
    setQty(req.user.id, id, qty);
    res.json(loadCart(req.user.id, req.user));
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:id', (req, res, next) => {
  try {
    removeItem(req.user.id, pid(req.params.id));
    res.json(loadCart(req.user.id, req.user));
  } catch (err) {
    next(err);
  }
});

router.delete('/', (req, res) => {
  clearCart(req.user.id);
  res.json(loadCart(req.user.id, req.user));
});
