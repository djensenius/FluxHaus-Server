import HomeConnect from './homeconnect';

async function getToken(hc: HomeConnect) {
  await hc.getToken();
}

async function listenEvents(hc: HomeConnect) {
  await hc.listenEvents();
}

const clientId = process.env.boschClientId || '';
const secretId = process.env.boschSecretId || '';
const hc = new HomeConnect(clientId, secretId);

// hc.authorize();
// getToken(hc);
// hc.refreshToken();
listenEvents(hc);
