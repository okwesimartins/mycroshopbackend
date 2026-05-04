const admin = require('firebase-admin');

let firebaseApp = null;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase credentials not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env');
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey })
  }, 'mycroshop');

  return firebaseApp;
}

/**
 * Send push notification to a single device token
 */
async function sendPushNotification(token, title, body, data = {}) {
  const app = getFirebaseApp();
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  return admin.messaging(app).send({
    token,
    notification: { title, body },
    data: stringData,
    android: { notification: { channelId: 'mycroshop_orders', priority: 'high' } },
    apns: { payload: { aps: { badge: 1, sound: 'default' } } }
  });
}

/**
 * Send push notification to multiple device tokens (multicast)
 * Returns { successCount, failureCount, invalidTokens }
 */
async function sendToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { successCount: 0, failureCount: 0, invalidTokens: [] };

  const app = getFirebaseApp();
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const response = await admin.messaging(app).sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData,
    android: { notification: { channelId: 'mycroshop_orders', priority: 'high' } },
    apns: { payload: { aps: { badge: 1, sound: 'default' } } }
  });

  // Collect tokens that are no longer valid (to remove from DB)
  const invalidTokens = [];
  response.responses.forEach((resp, idx) => {
    if (!resp.success) {
      const code = resp.error?.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        invalidTokens.push(tokens[idx]);
      }
    }
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokens
  };
}

module.exports = { sendPushNotification, sendToTokens };
