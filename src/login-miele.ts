import express, { Express } from 'express';
import Miele from './miele';


const clientId = process.env.mieleClientId || '';
const secretId = process.env.mieleSecretId || '';
const miele = new Miele(clientId, secretId);

const port = process.env.PORT || 8080;

async function createServer(): Promise<Express> {
  const app: Express = express();
  app.get('/auth/miele/callback', async (req, res) => {
    const code = req.query.code as string;
    await miele.getToken(code);
    res.send('Check your console for instructions');
  });
  return app;
}
createServer().then((app) => {
  app.listen(port, () => {
    miele.authorize();
    console.warn(`⚡️[server]: Server is running at https://localhost:${port}`);
  });
});
