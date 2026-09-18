const express = require('express');
const { google } = require('googleapis');
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Servir index.html en la raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Configuración OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Almacenamiento de tokens en memoria (para desarrollo)
let accounts = {};

// Ruta: Obtener URL de autorización
app.get('/auth/url', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  res.json({ url: authUrl });
});

// Ruta: Manejar callback de Google
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Obtener email del usuario
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    
    // Guardar token
    accounts[email] = tokens;
    
    res.send(`
      <h1>¡Autorización exitosa!</h1>
      <p>Cuenta: ${email}</p>
      <p>Podés cerrar esta ventana y volver al dashboard.</p>
      <script>
        window.opener.postMessage({ type: 'AUTH_SUCCESS', email: '${email}' }, '*');
        setTimeout(() => window.close(), 2000);
      </script>
    `);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Ruta: Listar cuentas conectadas
app.get('/accounts', (req, res) => {
  const accountList = Object.keys(accounts);
  res.json({ accounts: accountList });
});

// Ruta: Búsqueda paralela en Gmail + Drive
app.post('/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query required' });
  }

  const accountList = Object.keys(accounts);
  
  if (accountList.length === 0) {
    return res.status(400).json({ error: 'No accounts connected' });
  }

  const results = { gmail: [], drive: [] };

  // Búsqueda en paralelo
  const promises = accountList.map(async (email) => {
    const tokens = accounts[email];
    const client = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    client.setCredentials(tokens);

    try {
      // Gmail search
      const gmail = google.gmail({ version: 'v1', auth: client });
      const gmailRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 5,
      });

      if (gmailRes.data.messages) {
        gmailRes.data.messages.forEach((msg) => {
          results.gmail.push({
            email,
            messageId: msg.id,
            threadId: msg.threadId,
          });
        });
      }

      // Drive search
      const drive = google.drive({ version: 'v3', auth: client });
      const driveRes = await drive.files.list({
        q: `name contains '${query}' or fullText contains '${query}'`,
        spaces: 'drive',
        pageSize: 5,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
      });

      if (driveRes.data.files) {
        driveRes.data.files.forEach((file) => {
          results.drive.push({
            email,
            fileId: file.id,
            name: file.name,
            type: file.mimeType,
            modified: file.modifiedTime,
            link: file.webViewLink,
          });
        });
      }
    } catch (error) {
      console.error(`Error searching in ${email}:`, error.message);
    }
  });

  await Promise.all(promises);
  res.json(results);
});

// Ruta: Remover cuenta
app.post('/remove-account', (req, res) => {
  const { email } = req.body;
  if (accounts[email]) {
    delete accounts[email];
    res.json({ success: true, message: `${email} removed` });
  } else {
    res.status(400).json({ error: 'Account not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
