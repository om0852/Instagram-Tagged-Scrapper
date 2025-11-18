/**
 * Instagram Public Profile Scraper for Apify
 * Scrapes PUBLIC posts and reels WITHOUT login (TOS compliant)
 * 
 * @author Your Name
 * @version 2.0.0
 */

const { Actor } = require('apify');
const { PuppeteerCrawler, ProxyConfiguration } = require('crawlee');

// Constants
const MAX_REQUESTS_PER_CRAWL = 100;
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Parse Instagram date string to Date object
 */
function parseInstagramDate(dateString) {
    if (!dateString) return new Date();
    
    const now = new Date();
    const lower = dateString.toLowerCase();
    
    if (lower.includes('h')) {
        const hours = parseInt(dateString, 10);
        return new Date(now.getTime() - hours * 60 * 60 * 1000);
    } else if (lower.includes('d')) {
        const days = parseInt(dateString, 10);
        return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    } else if (lower.includes('w')) {
        const weeks = parseInt(dateString, 10);
        return new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
    }
    
    return new Date(dateString);
}

/**
 * Extract post details from page
 */
async function extractPostDetails(page) {
    return page.evaluate(() => {
        const postUrl = window.location.href;
        const postIdMatch = postUrl.match(/\/p\/([^\/\?]+)/);
        const postId = postIdMatch ? postIdMatch[1] : null;

        // Get media
        const mediaElement = document.querySelector('article img, article video');
        const mediaUrl = mediaElement?.src || null;
        
        // Get caption
        let caption = '';
        const h1Elements = document.querySelectorAll('h1');
        if (h1Elements.length > 0) {
            caption = h1Elements[0].textContent;
        }

        // Get engagement metrics
        let likes = '0';
        const sections = document.querySelectorAll('section');
        for (const section of sections) {
            const text = section.textContent;
            if (text.includes('like')) {
                const match = text.match(/[\d,]+\s*like/i);
                if (match) likes = match[0];
                break;
            }
        }

        // Get timestamp
        const timeElement = document.querySelector('time');
        const timestamp = timeElement?.getAttribute('datetime') || null;
        const timeText = timeElement?.textContent || null;

        return {
            type: 'post',
            postId,
            postUrl,
            mediaUrl,
            caption: caption.trim(),
            likes: likes.trim(),
            timestamp,
            timeText,
            scrapedAt: new Date().toISOString()
        };
    });
}

/**
 * Extract reel details from page
 */
async function extractReelDetails(page) {
    return page.evaluate(() => {
        const reelUrl = window.location.href;
        const reelIdMatch = reelUrl.match(/\/reel\/([^\/\?]+)/);
        const reelId = reelIdMatch ? reelIdMatch[1] : null;

        const videoElement = document.querySelector('video');
        const videoUrl = videoElement?.src || null;

        let caption = '';
        const h1Elements = document.querySelectorAll('h1');
        if (h1Elements.length > 0) {
            caption = h1Elements[0].textContent;
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

        return {
            type: 'reel',
            reelId,
            reelUrl,
            videoUrl,
            caption: caption.trim(),
            likes: likes.trim(),
            views: views.trim(),
            timestamp,
            timeText,
            scrapedAt: new Date().toISOString()
        };
    });
}

/**
 * Main Actor entry point
 */
Actor.main(async () => {
    // Get input
    const input = await Actor.getInput();
    
    // Validate input
    if (!input?.profileUrl) {
        throw new Error('profileUrl is required in input');
    }
    
    const {
        profileUrl,
        maxPosts = 50,
        maxReels = 50,
        timePeriodDays = 7,
        useProxy = true,
        proxyConfiguration
    } = input;

    await Actor.log.info(`Starting scrape for: ${profileUrl}`);
    await Actor.log.info(`Max posts: ${maxPosts}, Max reels: ${maxReels}`);

    // Setup proxy configuration
    let proxyConfig;
    if (useProxy) {
        proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        await Actor.log.info('Proxy configuration created');
    }

    // Calculate date threshold
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - timePeriodDays);
    await Actor.log.info(`Filtering content newer than: ${dateThreshold.toISOString()}`);

    // Initialize counters
    let postsScraped = 0;
    let reelsScraped = 0;
    const processedIds = new Set();

    // Create crawler
    const crawler = new PuppeteerCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: REQUEST_TIMEOUT_MS / 1000,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled'
                ]
            }
        },
        
        async requestHandler({ page, request }) {
            const url = request.url;
            
            await Actor.log.info(`Processing: ${url}`);
            
            // Wait for content to load
            await page.waitForSelector('article', { timeout: 30000 });
            await page.waitForTimeout(2000);

            // Determine content type
            if (url.includes('/p/')) {
                // Post
                const postIdMatch = url.match(/\/p\/([^\/\?]+)/);
                const postId = postIdMatch?.[1];
                
                if (!postId || processedIds.has(postId) || postsScraped >= maxPosts) {
                    return;
                }
                
                const postData = await extractPostDetails(page);
                
                // Check date filter
                const postDate = parseInstagramDate(postData.timeText);
                if (postDate < dateThreshold) {
                    await Actor.log.info(`Skipping old post: ${postData.timeText}`);
                    return;
                }
                
                processedIds.add(postId);
                postsScraped++;
                
                await Actor.pushData({
                    ...postData,
                    profileUrl
                });
                
                await Actor.log.info(`✅ Post saved (${postsScraped}/${maxPosts}): ${postData.likes} likes`);
                
            } else if (url.includes('/reel/')) {
                // Reel
                const reelIdMatch = url.match(/\/reel\/([^\/\?]+)/);
                const reelId = reelIdMatch?.[1];
                
                if (!reelId || processedIds.has(reelId) || reelsScraped >= maxReels) {
                    return;
                }
                
                const reelData = await extractReelDetails(page);
                
                // Check date filter
                const reelDate = parseInstagramDate(reelData.timeText);
                if (reelDate < dateThreshold) {
                    await Actor.log.info(`Skipping old reel: ${reelData.timeText}`);
                    return;
                }
                
                processedIds.add(reelId);
                reelsScraped++;
                
                await Actor.pushData({
                    ...reelData,
                    profileUrl
                });
                
                await Actor.log.info(`✅ Reel saved (${reelsScraped}/${maxReels}): ${reelData.views} views`);
                
            } else if (url === profileUrl) {
                // Profile page - collect URLs
                await Actor.log.info('Collecting content URLs from profile...');
                
                // Scroll to load content
                for (let i = 0; i < 3; i++) {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await page.waitForTimeout(2000);
                }
                
                // Extract URLs
                const contentUrls = await page.evaluate(() => {
                    const posts = [];
                    const reels = [];
                    
                    document.querySelectorAll('a[href*="/p/"]').forEach(link => {
                        const href = link.getAttribute('href');
                        if (href) {
                            posts.push(href.startsWith('http') ? href : `https://www.instagram.com${href}`);
                        }
                    });
                    
                    document.querySelectorAll('a[href*="/reel/"]').forEach(link => {
                        const href = link.getAttribute('href');
                        if (href) {
                            reels.push(href.startsWith('http') ? href : `https://www.instagram.com${href}`);
                        }
                    });
                    
                    return {
                        posts: Array.from(new Set(posts)),
                        reels: Array.from(new Set(reels))
                    };
                });
                
                await Actor.log.info(`Found ${contentUrls.posts.length} posts, ${contentUrls.reels.length} reels`);
                
                // Add URLs to request queue
                const requestQueue = await Actor.openRequestQueue();
                
                for (const postUrl of contentUrls.posts.slice(0, maxPosts)) {
                    await requestQueue.addRequest({ url: postUrl });
                }
                
                for (const reelUrl of contentUrls.reels.slice(0, maxReels)) {
                    await requestQueue.addRequest({ url: reelUrl });
                }
            }
        },
        
        failedRequestHandler: async ({ request }, error) => {
            await Actor.log.error(`Request failed: ${request.url} - ${error.message}`);
        }
    });

    // Start with profile URL
    await crawler.run([profileUrl]);

    // Save summary
    await Actor.setValue('OUTPUT', {
        profileUrl,
        totalPosts: postsScraped,
        totalReels: reelsScraped,
        totalItems: postsScraped + reelsScraped,
        scrapedAt: new Date().toISOString(),
        timePeriodDays
    });

    await Actor.log.info('✅ Scraping completed successfully');
    await Actor.log.info(`Total posts: ${postsScraped}, Total reels: ${reelsScraped}`);
});