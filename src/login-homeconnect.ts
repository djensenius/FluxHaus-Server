import HomeConnect from './homeconnect';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getToken(hc: HomeConnect) {
  await hc.getToken();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function listenEvents(hc: HomeConnect) {
  await hc.listenEvents();
}

const clientId = process.env.boschClientId || '';
const secretId = process.env.boschSecretId || '';
const hc = new HomeConnect(clientId, secretId);

hc.authorize();
getToken(hc);
/*
listenEvents(hc);
setInterval(() => {
  console.warn(hc.dishwasher);
}, 5000);
*/
