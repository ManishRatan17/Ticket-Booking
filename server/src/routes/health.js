import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

export default router;

//create a health check endpoint that returns the status of the server and its uptime.



