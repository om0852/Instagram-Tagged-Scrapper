import express from 'express';
import chromium from 'chrome-aws-lambda';
import puppeteerCore from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import randomUseragent from 'random-useragent';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { ensureSessionDir, loadSession, saveSession } from './sessionManager.js';

dotenv.config();

puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let proxyCursor = 0;
let accountCursor = 0;
const cursorLock = { proxy: false, account: false };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const CONFIG = {
  INSTAGRAM_USERNAME: process.env.IG_USERNAME || '',
  INSTAGRAM_PASSWORD: process.env.IG_PASSWORD || '',
  DAYS_TO_SCRAPE: parseInt(process.env.DAYS_TO_SCRAPE, 10) || 2,
  OUTPUT_DIR: process.env.OUTPUT_DIR || path.join(__dirname, 'scraped_instagram'),
  MAX_POSTS: parseInt(process.env.MAX_POSTS, 10) || 500,
  MAX_REELS: parseInt(process.env.MAX_REELS, 10) || 500,
  LOAD_DELAY: 3000,
  SCROLL_DELAY: 2000,
  USE_ACCOUNT_POOL: process.env.USE_ACCOUNT_POOL === 'true',
  ACCOUNTS: [
    {
      username: process.env.IG_USERNAME || '',
      password: process.env.IG_PASSWORD || ''
    }
  ],
  USE_PROXIES: process.env.USE_PROXIES !== 'false',
  PROXIES: [
    process.env.IG_PROXY_1 || '',
    process.env.IG_PROXY_2 || ''
  ],
  RATE_LIMIT_COOLDOWN_MS: [120000, 240000],
  MAX_RATE_LIMIT_EVENTS: 3,
  POSTS_PER_RUN_LIMIT: 150,
  REELS_PER_RUN_LIMIT: 150,
  RUN_LOG_FILE: 'instagram_run_logs.jsonl',
  ITEM_COOLDOWN_RANGE_MS: [2500, 5500],
  BATCH_SIZE_BEFORE_BREAK: 8,
  BATCH_BREAK_RANGE_MS: [20000, 40000],
  HUMAN_PAUSE_RANGE_MS: [4500, 8500],
  MICRO_PAUSE_RANGE_MS: [1500, 3500],
  VIEWPORTS: [
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 }
  ],
  USE_APIFY_PROXY: process.env.USE_APIFY_PROXY === 'true',
  APIFY_PROXY_GROUPS: (process.env.APIFY_PROXY_GROUPS || '')
    .split(',')
    .map(group => group.trim())
    .filter(Boolean),
  APIFY_PROXY_COUNTRY: process.env.APIFY_PROXY_COUNTRY || '',
  APIFY_PROXY_SESSION_PREFIX: process.env.APIFY_PROXY_SESSION_PREFIX || 'ig-session'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomPause(range = CONFIG.MICRO_PAUSE_RANGE_MS) {
  const duration = randomBetween(range[0], range[1]);
  await sleep(duration);
}

async function cooldownPause() {
  await randomPause(CONFIG.ITEM_COOLDOWN_RANGE_MS);
}

function getRandomViewport() {
  return CONFIG.VIEWPORTS[Math.floor(Math.random() * CONFIG.VIEWPORTS.length)];
}

function getRandomUserAgent() {
  return (
    randomUseragent.getRandom() ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
}

function sanitizeLabel(value) {
  if (!value) return 'default';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'default';
}

function getAccountPool() {
  const pool = (CONFIG.ACCOUNTS || []).filter(acc => acc && acc.username && acc.password);
  if (pool.length) return pool;

  if (!CONFIG.INSTAGRAM_USERNAME || !CONFIG.INSTAGRAM_PASSWORD) {
    throw new Error('Instagram credentials not configured. Please set IG_USERNAME and IG_PASSWORD environment variables.');
  }

  return [
    {
      username: CONFIG.INSTAGRAM_USERNAME,
      password: CONFIG.INSTAGRAM_PASSWORD
    }
  ];
}

async function getNextAccount() {
  const pool = getAccountPool();
  if (!CONFIG.USE_ACCOUNT_POOL || pool.length === 1) {
    return pool[0];
  }

  while (cursorLock.account) {
    await sleep(10);
  }
  cursorLock.account = true;
  const currentIndex = accountCursor % pool.length;
  const account = pool[currentIndex];
  accountCursor = (accountCursor + 1) % pool.length;
  cursorLock.account = false;

  return account;
}

async function resolveExecutablePath() {
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_VERSION;
  if (isLambda) {
    return await chromium.executablePath;
  }

  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  return await chromium.executablePath;
}

async function createChromiumLaunchOptions(proxyUrl) {
  const executablePath = await resolveExecutablePath();

  const defaultArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080'
  ];

  const chromiumArgs = chromium.args || [];
  const args = Array.from(new Set([...chromiumArgs, ...defaultArgs]));
  if (proxyUrl) {
    args.push(`--proxy-server=${proxyUrl}`);
  }

  return {
    executablePath,
    headless: process.env.HEADLESS !== 'false',
    args,
    defaultViewport: null,
    ignoreHTTPSErrors: true
  };
}

async function createApifyProxyUrl() {
  const password = process.env.APIFY_PROXY_PASSWORD;
  if (!password) {
    throw new Error('Apify proxy enabled but APIFY_PROXY_PASSWORD is not set.');
  }

  const segments = [];
  if (CONFIG.APIFY_PROXY_GROUPS.length) {
    segments.push(`groups-${CONFIG.APIFY_PROXY_GROUPS.join('+')}`);
  }
  if (CONFIG.APIFY_PROXY_COUNTRY) {
    segments.push(`country-${CONFIG.APIFY_PROXY_COUNTRY}`);
  }
  segments.push(`session-${CONFIG.APIFY_PROXY_SESSION_PREFIX}-${Date.now().toString(36)}`);

  const username = segments.join(',') || 'auto';
  return `http://${username}:${password}@proxy.apify.com:8000`;
}

async function getNextProxy() {
  if (CONFIG.USE_APIFY_PROXY) {
    return createApifyProxyUrl();
  }

  if (!CONFIG.USE_PROXIES) return null;
  const pool = CONFIG.PROXIES.filter(Boolean);
  if (!pool.length) return null;

  while (cursorLock.proxy) {
    await sleep(10);
  }
  cursorLock.proxy = true;
  const currentIndex = proxyCursor % pool.length;
  const proxy = pool[currentIndex];
  proxyCursor = (proxyCursor + 1) % pool.length;
  cursorLock.proxy = false;

  return proxy;
}

async function handleRateLimitPause(runMetrics) {
  console.log('🚧 Rate limit detected. Cooling down...');
  runMetrics.rateLimitEvents += 1;
  if (runMetrics.rateLimitEvents >= CONFIG.MAX_RATE_LIMIT_EVENTS) {
    console.log('⚠️ Rate limit threshold exceeded for this run.');
    throw new Error('Too many rate-limit responses; aborting run to protect account.');
  }
  await randomPause(CONFIG.RATE_LIMIT_COOLDOWN_MS);
}

async function isRateLimited(page) {
  try {
    const textContent = await page.evaluate(() => document.body.innerText || '');
    if (!textContent) return false;
    const normalized = textContent.toLowerCase();
    return (
      normalized.includes('try again later') ||
      normalized.includes('wait a few minutes') ||
      normalized.includes('we restrict certain activity')
    );
  } catch (error) {
    console.log('Rate-limit check failed:', error.message);
    return false;
  }
}

async function appendRunLog(entry) {
  try {
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    const logPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.RUN_LOG_FILE);
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    console.log('⚠️ Unable to write run log:', error.message);
  }
}

async function maybeTakeBatchBreak(processedCount, typeLabel = 'items') {
  if (
    CONFIG.BATCH_SIZE_BEFORE_BREAK > 0 &&
    processedCount > 0 &&
    processedCount % CONFIG.BATCH_SIZE_BEFORE_BREAK === 0
  ) {
    console.log(`\n💤 Taking a longer rest after ${processedCount} ${typeLabel}...`);
    await randomPause(CONFIG.BATCH_BREAK_RANGE_MS);
  }
}

async function ensureOutputDir() {
  try {
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    console.log('✓ Output directory ready:', CONFIG.OUTPUT_DIR);
  } catch (error) {
    console.error('Error creating output directory:', error);
  }
}

function getDateThreshold() {
  const now = new Date();
  return new Date(now.getTime() - CONFIG.DAYS_TO_SCRAPE * 24 * 60 * 60 * 1000);
}

function getDateThresholdByPeriod(period) {
  const now = new Date();
  let milliseconds = 0;

  switch (period?.toLowerCase()) {
    case '1h':
    case '1hour':
      milliseconds = 1 * 60 * 60 * 1000;
      break;
    case '3h':
    case '3hours':
      milliseconds = 3 * 60 * 60 * 1000;
      break;
    case '24h':
    case '24hours':
    case '1day':
      milliseconds = 24 * 60 * 60 * 1000;
      break;
    case '1w':
    case '1week':
    case '7days':
      milliseconds = 7 * 24 * 60 * 60 * 1000;
      break;
    case '1m':
    case '1month':
    case '30days':
      milliseconds = 30 * 24 * 60 * 60 * 1000;
      break;
    case '1y':
    case '1year':
    case '365days':
      milliseconds = 365 * 24 * 60 * 60 * 1000;
      break;
    default:
      return getDateThreshold();
  }

  return new Date(now.getTime() - milliseconds);
}

function parseInstagramDate(dateString) {
  if (!dateString) return new Date();

  const now = new Date();
  const lowerDate = dateString.toLowerCase();

  if (lowerDate.includes('h') || lowerDate.includes('hour')) {
    const hours = parseInt(dateString, 10);
    return new Date(now.getTime() - hours * 60 * 60 * 1000);
  } else if (lowerDate.includes('d') || lowerDate.includes('day')) {
    const days = parseInt(dateString, 10);
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  } else if (lowerDate.includes('w') || lowerDate.includes('week')) {
    const weeks = parseInt(dateString, 10);
    return new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
  } else if (lowerDate.includes('m') && !lowerDate.includes('min')) {
    const months = parseInt(dateString, 10);
    return new Date(now.getTime() - months * 30 * 24 * 60 * 60 * 1000);
  }

  return new Date(dateString);
}

async function loginToInstagram(page, credentials) {
  const creds = credentials || {
    username: CONFIG.INSTAGRAM_USERNAME,
    password: CONFIG.INSTAGRAM_PASSWORD
  };
  try {
    console.log('Attempting to login...');
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await randomPause(CONFIG.HUMAN_PAUSE_RANGE_MS);

    console.log(`Entering credentials for ${creds.username}...`);
    const typingDelay = randomBetween(80, 160);
    await page.type('input[name="username"]', creds.username, { delay: typingDelay });
    await randomPause();
    await page.type('input[name="password"]', creds.password, { delay: typingDelay });
    await randomPause();

    console.log('Clicking login button...');
    await page.click('button[type="submit"]');
    await randomPause(CONFIG.HUMAN_PAUSE_RANGE_MS);

    const currentUrl = page.url();
    console.log('Current URL after login:', currentUrl);

    if (currentUrl.includes('/accounts/login') || currentUrl.includes('/challenge')) {
      const errorMessage = await page.evaluate(() => {
        const errorDiv = document.querySelector('#slfErrorAlert');
        return errorDiv ? errorDiv.textContent : null;
      });

      if (errorMessage) throw new Error(`Login failed: ${errorMessage}`);
      if (currentUrl.includes('/challenge')) throw new Error('Login requires verification');
    }

    console.log('✓ Login successful, handling prompts...');

    try {
      await randomPause(CONFIG.HUMAN_PAUSE_RANGE_MS);
      const notNowButtons = await page.$$('button');
      for (const button of notNowButtons) {
        const text = await page.evaluate(el => el.textContent, button);
        if (text && (text.includes('Not Now') || text.includes('Not now'))) {
          await button.click();
          console.log('✓ Clicked "Not Now" for save login');
          await randomPause();
          break;
        }
      }
    } catch {
      console.log('No save login prompt');
    }

    try {
      await randomPause();
      const buttons = await page.$$('button');
      for (const button of buttons) {
        const text = await page.evaluate(el => el.textContent, button);
        if (text && (text.includes('Not Now') || text.includes('Not now'))) {
          await button.click();
          console.log('✓ Clicked "Not Now" for notifications');
          await randomPause();
          break;
        }
      }
    } catch {
      console.log('No notification prompt');
    }

    console.log('✓ Login complete and ready to scrape');
    return true;
  } catch (error) {
    console.error('❌ Login failed:', error.message);
    try {
      await page.screenshot({ path: 'login_error.png' });
      console.log('Screenshot saved: login_error.png');
    } catch {}
    return false;
  }
}

async function scrollAndLoadContent(page) {
  console.log('Scrolling to load more content...');
  let previousHeight = 0;
  let scrollAttempts = 0;
  const maxScrolls = 5;

  while (scrollAttempts < maxScrolls) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      console.log('Reached end of content or no new content loaded');
      break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomPause(CONFIG.HUMAN_PAUSE_RANGE_MS);

    previousHeight = currentHeight;
    scrollAttempts++;
    console.log(`Scroll ${scrollAttempts}/${maxScrolls}`);
  }
}

async function extractPostDetails(page, postNumber) {
  try {
    await sleep(CONFIG.LOAD_DELAY);

    const postData = await page.evaluate(() => {
      const postUrl = window.location.href;
      const postIdMatch = postUrl.match(/\/p\/([^\/\?]+)/);
      const postId = postIdMatch ? postIdMatch[1] : null;

      const mediaElement = document.querySelector('article img') || document.querySelector('article video');
      const mediaUrl = mediaElement?.src || mediaElement?.getAttribute('src') || null;
      const altText = mediaElement?.alt || '';

      let caption = '';
      const h1Elements = document.querySelectorAll('h1');
      if (h1Elements.length > 0) {
        caption = h1Elements[0].textContent;
      }

      if (!caption) {
        const spans = document.querySelectorAll('span');
        for (const span of spans) {
          if (span.textContent.length > 50) {
            caption = span.textContent;
            break;
          }
        }
      }

      let likes = '0';
      const sections = document.querySelectorAll('section');
      for (const section of sections) {
        const text = section.textContent;
        if (text.includes('like') || text.includes('Like')) {
          const match = text.match(/[\d,]+\s*like/i);
          if (match) {
            likes = match[0];
            break;
          }
        }
      }

      const timeElement = document.querySelector('time');
      const timestamp = timeElement?.getAttribute('datetime') || null;
      const timeText = timeElement?.textContent || null;

      let commentsCount = '0';
      const buttons = document.querySelectorAll('button, span');
      for (const elem of buttons) {
        const text = elem.textContent;
        if (text.includes('comment')) {
          const match = text.match(/[\d,]+/);
          if (match) {
            commentsCount = match[0];
            break;
          }
        }
      }

      let location = '';
      const locationLinks = document.querySelectorAll('a[href*="/explore/locations/"]');
      if (locationLinks.length > 0) {
        location = locationLinks[0].textContent;
      }

      return {
        type: 'post',
        postUrl,
        postId,
        mediaUrl,
        altText,
        caption: caption.trim(),
        likes: likes.trim(),
        commentsCount: commentsCount.trim(),
        location: location.trim(),
        timestamp,
        timeText,
        scrapedAt: new Date().toISOString()
      };
    });

    console.log(`✓ Post #${postNumber}: ${postData.likes} likes | ${postData.timeText}`);
    return postData;
  } catch (error) {
    console.error('Error extracting post:', error.message);
    return null;
  }
}

async function extractReelDetails(page, reelNumber) {
  try {
    await sleep(CONFIG.LOAD_DELAY);

    const reelData = await page.evaluate(() => {
      const reelUrl = window.location.href;
      const reelIdMatch = reelUrl.match(/\/reel\/([^\/\?]+)/);
      const reelId = reelIdMatch ? reelIdMatch[1] : null;

      const videoElement = document.querySelector('video');
      const videoUrl = videoElement?.src || videoElement?.getAttribute('src') || null;
      const posterUrl = videoElement?.poster || null;

      let caption = '';
      const h1Elements = document.querySelectorAll('h1');
      if (h1Elements.length > 0) {
        caption = h1Elements[0].textContent;
      }

      if (!caption || caption.length < 30) {
        const article = document.querySelector('article');
        if (article) {
          const spans = article.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent?.trim();
            if (text && text.length > 30 && text.length < 2200) {
              caption = text;
              break;
            }
          }
        }
      }

      const article = document.querySelector('article');
      const allText = article ? article.innerText : document.body.innerText;

      let likes = '0';
      const likeMatch = allText.match(/(\d[\d,\.]*[KM]?)\s*like/i);
      if (likeMatch) likes = likeMatch[1];

      let views = '0';
      const viewMatch = allText.match(/(\d[\d,\.]*[KM]?)\s*views?/i);
      if (viewMatch) views = viewMatch[1];

      const timeElement = document.querySelector('time');
      const timestamp = timeElement?.getAttribute('datetime') || null;
      const timeText = timeElement?.textContent || null;

      let commentsCount = '0';
      const commentMatch = allText.match(/(\d[\d,]*)\s*comment/i);
      if (commentMatch) commentsCount = commentMatch[1];

      let audioName = '';
      const audioLinks = document.querySelectorAll('a[href*="/audio/"]');
      if (audioLinks.length > 0) audioName = audioLinks[0].textContent;

      const hashtags = [];
      const hashtagLinks = document.querySelectorAll('a[href*="/explore/tags/"]');
      hashtagLinks.forEach(link => hashtags.push(link.textContent));

      return {
        type: 'reel',
        reelUrl,
        reelId,
        videoUrl,
        posterUrl,
        caption: caption.trim(),
        likes: likes.trim(),
        views: views.trim(),
        commentsCount: commentsCount.trim(),
        audioName: audioName.trim(),
        hashtags,
        timestamp,
        timeText,
        scrapedAt: new Date().toISOString()
      };
    });

    console.log(`✓ Reel #${reelNumber}: ${reelData.views} views | ${reelData.likes} likes | ${reelData.timeText}`);
    return reelData;
  } catch (error) {
    console.error('Error extracting reel:', error.message);
    return null;
  }
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const navIcon =
        document.querySelector('svg[aria-label="Home"]') || document.querySelector('svg[aria-label="Create"]');
      const loginInput = document.querySelector('input[name="username"]');
      return !!navIcon || !loginInput;
    });
  } catch (error) {
    console.log('Login status check failed:', error.message);
    return false;
  }
}

async function scrapeInstagram(profileUrl, timePeriod = null, requestId = null) {
  const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  let browser;
  const account = await getNextAccount();
  const sessionLabel = sanitizeLabel(account.username);
  const proxyUsed = await getNextProxy();

  const runMetrics = {
    requestId: reqId,
    startedAt: new Date().toISOString(),
    account: account.username,
    profileUrl,
    proxy: proxyUsed || 'none',
    postsSaved: 0,
    reelsSaved: 0,
    rateLimitEvents: 0,
    notes: []
  };
  const scrapedPosts = [];
  const scrapedReels = [];
  let postLimitReached = false;
  let reelLimitReached = false;

  try {
    console.log(`[${reqId}] Launching browser...`);
    const launchOptions = await createChromiumLaunchOptions(proxyUsed);

    browser = await puppeteer.launch(launchOptions);

    const mainPage = await browser.newPage();
    await mainPage.setViewport(getRandomViewport());
    await mainPage.setUserAgent(getRandomUserAgent());

    const dateThreshold = timePeriod ? getDateThresholdByPeriod(timePeriod) : getDateThreshold();
    if (timePeriod) {
      console.log(`[${reqId}] 📅 Filtering content from last: ${timePeriod}`);
    }

    await ensureSessionDir(sessionLabel);
    await mainPage.goto('https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    const restored = await loadSession(mainPage, sessionLabel);
    if (restored) {
      await mainPage.reload({ waitUntil: 'networkidle0', timeout: 60000 });
    }

    let loggedIn = await isLoggedIn(mainPage);

    if (!loggedIn) {
      const loginSuccess = await loginToInstagram(mainPage, account);
      if (!loginSuccess) {
        throw new Error('Failed to login to Instagram');
      }
      await saveSession(mainPage, sessionLabel);
      loggedIn = true;
    } else {
      console.log('✓ Using existing Instagram session');
    }

    console.log(`[${reqId}] Navigating to profile: ${profileUrl}...`);
    await mainPage.goto(profileUrl, {
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    if (await isRateLimited(mainPage)) {
      await handleRateLimitPause(runMetrics);
      await mainPage.reload({ waitUntil: 'networkidle0', timeout: 60000 });
    }
    await sleep(4000);
    console.log('✓ Profile page loaded');

    await scrollAndLoadContent(mainPage);

    console.log('\nCollecting content URLs...');
    await sleep(2000);

    const contentUrls = await mainPage.evaluate(() => {
      const posts = [];
      const reels = [];

      document.querySelectorAll('a[href*="/p/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          posts.push(fullUrl);
        }
      });

      document.querySelectorAll('a[href*="/reel/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          reels.push(fullUrl);
        }
      });

      return {
        posts: Array.from(new Set(posts)),
        reels: Array.from(new Set(reels))
      };
    });

    console.log(`\n📊 Found ${contentUrls.posts.length} posts and ${contentUrls.reels.length} reels`);

    const processedIds = new Set();

    console.log(`\n📸 Starting to scrape POSTS...\n`);
    let consecutiveOldPosts = 0;
    const MAX_CONSECUTIVE_OLD_POSTS = 2;

    for (let i = 0; i < contentUrls.posts.length && scrapedPosts.length < CONFIG.MAX_POSTS; i++) {
      if (CONFIG.POSTS_PER_RUN_LIMIT && scrapedPosts.length >= CONFIG.POSTS_PER_RUN_LIMIT) {
        postLimitReached = true;
        break;
      }
      const postUrl = contentUrls.posts[i];
      let postPage;

      try {
        const postIdMatch = postUrl.match(/\/p\/([^\/\?]+)/);
        const postId = postIdMatch ? postIdMatch[1] : null;

        if (!postId || processedIds.has(postId)) {
          await randomPause();
          continue;
        }

        console.log(`[${scrapedPosts.length + 1}/${CONFIG.MAX_POSTS}] Opening post: ${postId}`);

        postPage = await browser.newPage();
        await postPage.setViewport(getRandomViewport());
        await postPage.setUserAgent(getRandomUserAgent());

        await postPage.goto(postUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        if (await isRateLimited(postPage)) {
          await handleRateLimitPause(runMetrics);
          await postPage.close();
          postPage = null;
          continue;
        }
        await randomPause(CONFIG.MICRO_PAUSE_RANGE_MS);

        const postData = await extractPostDetails(postPage, scrapedPosts.length + 1);

        if (postData) {
          processedIds.add(postId);
          const postDate = parseInstagramDate(postData.timeText);
          const isRecent = postDate >= dateThreshold;

          if (isRecent) {
            consecutiveOldPosts = 0;
            postData.postNumber = scrapedPosts.length + 1;
            scrapedPosts.push(postData);
            runMetrics.postsSaved = scrapedPosts.length;
            console.log(`✅ Saved post: ${postData.caption?.substring(0, 50)}...`);
            if (CONFIG.POSTS_PER_RUN_LIMIT && scrapedPosts.length >= CONFIG.POSTS_PER_RUN_LIMIT) {
              postLimitReached = true;
              runMetrics.notes.push(`Post limit ${CONFIG.POSTS_PER_RUN_LIMIT} reached`);
            }
          } else {
            consecutiveOldPosts += 1;
            console.log(
              `⏭️  Skipped (too old): ${postData.timeText} (streak: ${consecutiveOldPosts}/${MAX_CONSECUTIVE_OLD_POSTS})`
            );
            if (consecutiveOldPosts >= MAX_CONSECUTIVE_OLD_POSTS) {
              console.log('⛔ Encountered too many old posts in a row, stopping post scraping early.');
              postLimitReached = true;
            }
          }
        }

        await postPage.close();
        postPage = null;
      } catch (error) {
        console.error(`Error with post:`, error.message);
        if (postPage) {
          try {
            await postPage.close();
          } catch {}
        }
      }

      await cooldownPause();
      if (scrapedPosts.length > 0) {
        await maybeTakeBatchBreak(scrapedPosts.length, 'posts');
      }
      if (postLimitReached) break;
    }
    if (postLimitReached) {
      console.log('📵 Post per-run limit reached; stopping post scraping.');
    }

    console.log(`\n🎬 Starting to scrape REELS...\n`);
    let consecutiveOldReels = 0;
    const MAX_CONSECUTIVE_OLD_REELS = 2;

    for (let i = 0; i < contentUrls.reels.length && scrapedReels.length < CONFIG.MAX_REELS; i++) {
      if (CONFIG.REELS_PER_RUN_LIMIT && scrapedReels.length >= CONFIG.REELS_PER_RUN_LIMIT) {
        reelLimitReached = true;
        break;
      }
      const reelUrl = contentUrls.reels[i];
      let reelPage;

      try {
        const reelIdMatch = reelUrl.match(/\/reel\/([^\/\?]+)/);
        const reelId = reelIdMatch ? reelIdMatch[1] : null;

        if (!reelId || processedIds.has(reelId)) {
          await randomPause();
          continue;
        }

        console.log(`[${scrapedReels.length + 1}/${CONFIG.MAX_REELS}] Opening reel: ${reelId}`);

        reelPage = await browser.newPage();
        await reelPage.setViewport(getRandomViewport());
        await reelPage.setUserAgent(getRandomUserAgent());

        await reelPage.goto(reelUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        if (await isRateLimited(reelPage)) {
          await handleRateLimitPause(runMetrics);
          await reelPage.close();
          reelPage = null;
          continue;
        }
        await randomPause(CONFIG.MICRO_PAUSE_RANGE_MS);

        const reelData = await extractReelDetails(reelPage, scrapedReels.length + 1);

        if (reelData) {
          processedIds.add(reelId);
          const reelDate = parseInstagramDate(reelData.timeText);
          const isRecent = reelDate >= dateThreshold;

          if (isRecent) {
            consecutiveOldReels = 0;
            reelData.reelNumber = scrapedReels.length + 1;
            scrapedReels.push(reelData);
            runMetrics.reelsSaved = scrapedReels.length;
            console.log(`✅ Saved reel: ${reelData.caption?.substring(0, 50)}...`);
            if (CONFIG.REELS_PER_RUN_LIMIT && scrapedReels.length >= CONFIG.REELS_PER_RUN_LIMIT) {
              reelLimitReached = true;
              runMetrics.notes.push(`Reel limit ${CONFIG.REELS_PER_RUN_LIMIT} reached`);
            }
          } else {
            consecutiveOldReels += 1;
            console.log(
              `⏭️  Skipped (too old): ${reelData.timeText} (streak: ${consecutiveOldReels}/${MAX_CONSECUTIVE_OLD_REELS})`
            );
            if (consecutiveOldReels >= MAX_CONSECUTIVE_OLD_REELS) {
              console.log('⛔ Encountered too many old reels in a row, stopping reel scraping early.');
              reelLimitReached = true;
            }
          }
        }

        await reelPage.close();
        reelPage = null;
      } catch (error) {
        console.error(`Error with reel:`, error.message);
        if (reelPage) {
          try {
            await reelPage.close();
          } catch {}
        }
      }

      await cooldownPause();
      if (scrapedReels.length > 0) {
        await maybeTakeBatchBreak(scrapedReels.length, 'reels');
      }
      if (reelLimitReached) break;
    }
    if (reelLimitReached) {
      console.log('📵 Reel per-run limit reached; stopping reel scraping.');
    }

    console.log('\n✓ Scraping completed, closing browser...');
    try {
      await saveSession(mainPage, sessionLabel);
    } catch (e) {
      console.log('Unable to save session during shutdown:', e.message);
    }
    await mainPage.close();
    await browser.close();
    browser = null;

    const result = {
      posts: scrapedPosts,
      reels: scrapedReels,
      metadata: {
        profileUrl,
        totalPosts: scrapedPosts.length,
        totalReels: scrapedReels.length,
        dateThreshold: dateThreshold.toISOString(),
        timePeriod: timePeriod || `last ${CONFIG.DAYS_TO_SCRAPE} days`,
        scrapedAt: new Date().toISOString()
      }
    };
    runMetrics.postsSaved = scrapedPosts.length;
    runMetrics.reelsSaved = scrapedReels.length;
    runMetrics.status = 'success';
    runMetrics.finishedAt = result.metadata.scrapedAt;
    runMetrics.notes.push('Run completed successfully');
    await appendRunLog(runMetrics);
    console.log(`[${reqId}] ✓ Scraping completed: ${scrapedPosts.length} posts, ${scrapedReels.length} reels`);
    return result;
  } catch (error) {
    console.error(`[${reqId}] Error in scrapeInstagram:`, error.message);
    runMetrics.status = 'error';
    runMetrics.error = error.message;
    runMetrics.finishedAt = new Date().toISOString();
    runMetrics.notes.push(`Error: ${error.message}`);
    await appendRunLog(runMetrics);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error(`[${reqId}] Error closing browser:`, e.message);
      }
    }
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Instagram Posts & Reels Scraper (chromium/puppeteer-core)',
    endpoints: {
      scrape: 'POST /scrape - Scrape both posts and reels',
      health: 'GET /health - Health check'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  const { profileUrl, timePeriod } = req.body;
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  if (!profileUrl || !profileUrl.includes('instagram.com')) {
    return res.status(400).json({
      success: false,
      error: 'Valid Instagram profile URL required'
    });
  }

  const validPeriods = [
    '1h',
    '1hour',
    '3h',
    '3hours',
    '24h',
    '24hours',
    '1day',
    '1w',
    '1week',
    '7days',
    '1m',
    '1month',
    '30days',
    '1y',
    '1year',
    '365days'
  ];
  if (timePeriod && !validPeriods.includes(timePeriod.toLowerCase())) {
    return res.status(400).json({
      success: false,
      error: `Invalid time period. Valid options: ${validPeriods.join(', ')}`
    });
  }

  try {
    await ensureOutputDir();

    console.log(`\n[${requestId}] ${'='.repeat(70)}`);
    console.log(`[${requestId}] 📸🎬 SCRAPING POSTS & REELS: ${profileUrl}`);
    if (timePeriod) {
      console.log(`[${requestId}] 📅 Time Period Filter: ${timePeriod}`);
    }
    console.log(`[${requestId}] ${'='.repeat(70)}\n`);

    const result = await scrapeInstagram(profileUrl, timePeriod, requestId);

    const urlParts = profileUrl.split('/').filter(Boolean);
    const username =
      urlParts.find(
        part => !part.includes('instagram') && !part.includes('tagged') && !part.includes('www') && !part.includes('http')
      ) || 'instagram';

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(
      2,
      '0'
    )}-${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `${username}_posts_and_reels_${dateStr}_${requestId.substr(4, 9)}.json`;
    const filepath = path.join(CONFIG.OUTPUT_DIR, filename);

    const dataToSave = {
      profile: profileUrl,
      scrapedAt: new Date().toISOString(),
      summary: {
        totalPosts: result.posts.length,
        totalReels: result.reels.length,
        totalContent: result.posts.length + result.reels.length
      },
      posts: result.posts,
      reels: result.reels
    };

    await fs.writeFile(filepath, JSON.stringify(dataToSave, null, 2), 'utf8');

    console.log(`\n${'='.repeat(70)}`);
    console.log('✓ SCRAPING COMPLETED SUCCESSFULLY');
    console.log(`${'='.repeat(70)}`);
    console.log(`📸 Posts scraped: ${result.posts.length}`);
    console.log(`🎬 Reels scraped: ${result.reels.length}`);
    console.log(`📁 File saved: ${filename}`);
    console.log(`📍 Path: ${filepath}`);
    console.log(`${'='.repeat(70)}\n`);

    res.json({
      success: true,
      message: 'Scraping completed successfully',
      data: {
        postsCount: result.posts.length,
        reelsCount: result.reels.length,
        totalCount: result.posts.length + result.reels.length,
        filename,
        filepath,
        timePeriod: timePeriod || `last ${CONFIG.DAYS_TO_SCRAPE} days`
      },
      content: dataToSave
    });
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Check server logs for more information'
    });
  }
});

if (process.env.AWS_LAMBDA_FUNCTION_VERSION) {
} else {
  app.listen(PORT, async () => {
    console.log('\n' + '='.repeat(70));
    console.log('📸🎬 INSTAGRAM POSTS & REELS SCRAPER (chromium aws lambda compatible)');
    console.log('='.repeat(70));
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`📂 Output: ${CONFIG.OUTPUT_DIR}`);
    console.log(`📅 Scraping last: ${CONFIG.DAYS_TO_SCRAPE} days`);
    console.log(`📊 Max posts: ${CONFIG.MAX_POSTS} | Max reels: ${CONFIG.MAX_REELS}`);
    console.log('='.repeat(70));
    console.log('\n📖 ENDPOINT:');
    console.log('   POST /scrape - Scrape both posts & reels');
    console.log('\n💡 USAGE:');
    console.log(`   curl -X POST http://localhost:${PORT}/scrape \\`);
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"profileUrl": "https://www.instagram.com/giva.co/tagged/"}\'');
    console.log('\n📅 TIME PERIOD FILTERS (optional):');
    console.log('   - "1h" or "1hour" - Last 1 hour');
    console.log('   - "3h" or "3hours" - Last 3 hours');
    console.log('   - "24h" or "24hours" or "1day" - Last 24 hours');
    console.log('   - "1w" or "1week" or "7days" - Last 1 week');
    console.log('   - "1m" or "1month" or "30days" - Last 1 month');
    console.log('   - "1y" or "1year" or "365days" - Last 1 year');
    console.log(`\n   Example with filter:`);
    console.log(`   curl -X POST http://localhost:${PORT}/scrape \\`);
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"profileUrl": "https://www.instagram.com/username/", "timePeriod": "1h"}\'');
    console.log('\n' + '='.repeat(70) + '\n');

    await ensureOutputDir();
  });
}

export default app;

