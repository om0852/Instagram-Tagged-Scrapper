const fs = require('fs').promises;
const path = require('path');

const SESSION_ROOT = path.join(__dirname, 'session_data');

async function ensureSessionDir(label = 'default') {
  const dirPath = path.join(SESSION_ROOT, label);
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function getSessionPaths(label = 'default') {
  const dirPath = await ensureSessionDir(label);
  return {
    dir: dirPath,
    cookiesPath: path.join(dirPath, 'cookies.json'),
    localStoragePath: path.join(dirPath, 'localStorage.json')
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadSession(page, label = 'default') {
  const { cookiesPath, localStoragePath } = await getSessionPaths(label);
  let restored = false;

  if (await fileExists(cookiesPath)) {
    const cookiesJson = await fs.readFile(cookiesPath, 'utf8');
    const cookies = JSON.parse(cookiesJson);
    if (Array.isArray(cookies) && cookies.length > 0) {
      const normalized = cookies.map(cookie => {
        if (!cookie.url && !cookie.domain) {
          return { ...cookie, url: 'https://www.instagram.com' };
        }
        return cookie;
      });
      await page.setCookie(...normalized);
      restored = true;
    }
  }

  if (await fileExists(localStoragePath)) {
    const localStorageJson = await fs.readFile(localStoragePath, 'utf8');
    const localStorageData = JSON.parse(localStorageJson);
    await page.evaluate(data => {
      if (!data) return;
      Object.entries(data).forEach(([key, value]) => {
        localStorage.setItem(key, value);
      });
    }, localStorageData);
    restored = true;
  }

  if (restored) {
    console.log('🔁 Instagram session restored from disk');
  }

  return restored;
}

async function saveSession(page, label = 'default') {
  const { cookiesPath, localStoragePath } = await getSessionPaths(label);

  try {
    const cookies = await page.cookies();
    await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2), 'utf8');
  } catch (error) {
    console.log('⚠️ Unable to persist cookies:', error.message);
  }

  try {
    const localStorageData = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        data[key] = localStorage.getItem(key);
      }
      return data;
    });
    await fs.writeFile(localStoragePath, JSON.stringify(localStorageData, null, 2), 'utf8');
  } catch (error) {
    console.log('⚠️ Unable to persist localStorage:', error.message);
  }

  console.log('💾 Instagram session saved');
}

module.exports = {
  ensureSessionDir,
  loadSession,
  saveSession
};

