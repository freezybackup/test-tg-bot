const express = require('express');
const puppeteer = require('puppeteer-core');
const { Bot, webhookCallback, InputFile } = require('grammy');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('chrome-aws-lambda');

puppeteer.use(StealthPlugin());

async function getPuppeteerOptions() {
  const options = {
    args: chromium.args,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
  };
  return options;
}

process.setMaxListeners(15);

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

const bot = new Bot(botToken);

let shouldStopScraping = false;

async function scraping(ctx) {
  try {
    console.log('Starting scraping process...');
    const options = await getPuppeteerOptions();
    const browser = await puppeteer.launch(options);
    console.log('Browser launched.');

    const page = await browser.newPage();
    console.log('New page opened.');

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0"
    );
    console.log('User agent set.');

    await page.goto("https://opensea.io/rankings?sortBy=one_day_volume");
    console.log('Navigated to OpenSea rankings page.');

    let hrefLinks = [];
    let loadMoreButtonVisible = true;

    while (loadMoreButtonVisible && !shouldStopScraping) {
      await page.evaluate(() => {
        const scrollStep = window.innerHeight / 10;
        let scrollCount = 0;
        const scrollInterval = setInterval(() => {
          if (window.scrollY === document.body.scrollHeight - window.innerHeight) {
            clearInterval(scrollInterval);
          }
          window.scrollBy(0, scrollStep);
          scrollCount += 1;
          if (scrollCount >= 10) clearInterval(scrollInterval);
        }, 100);
      });

      await new Promise((resolve) => setTimeout(resolve, 4000));
      console.log('Page scrolled.');

      const newLinks = await page.evaluate(() => {
        const elements = document.querySelectorAll("a");
        return Array.from(elements).map((el) => el.href);
      });

      hrefLinks.push(...newLinks);
      hrefLinks = [...new Set(hrefLinks)];
      console.log('Links collected:', hrefLinks.length);

      loadMoreButtonVisible = await page.evaluate(() => {
        const button = document.evaluate(
          '//i[text()="arrow_forward_ios"]',
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
        return !!button;
      });

      if (loadMoreButtonVisible) {
        const isBottomReached = await page.evaluate(() => {
          return window.scrollY === document.body.scrollHeight - window.innerHeight;
        });

        if (isBottomReached) {
          await page.evaluate(() => {
            document
              .evaluate(
                '//i[text()="arrow_forward_ios"]',
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              )
              .singleNodeValue.click();
          });

          console.log("Clicked 'Load More' button");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          console.log("Scroll not complete, waiting...");
        }
      } else {
        console.log("No more 'Load More' button");
        break;
      }
    }

    if (shouldStopScraping) {
      await ctx.reply("Scraping process has been stopped.");
      await browser.close();
      return;
    }

    const collectionLinks = hrefLinks.filter((link) => link.includes("collection"));
    console.log('Filtered collection links:', collectionLinks.length);

    const collectionsWithDiscordLinks = [];
    const maxRetries = 3;

    for (const collectionLink of collectionLinks) {
      if (shouldStopScraping) {
        await ctx.reply("Scraping process has been stopped.");
        await browser.close();
        return;
      }

      let retries = 0;
      let pageLoaded = false;

      while (retries < maxRetries && !pageLoaded) {
        try {
          await page.goto(collectionLink, { timeout: 60000 });
          console.log("Opening Link:", collectionLink);
          ctx.reply(`Scraping <a href="${collectionLink}">Link</a>`, { parse_mode: 'HTML' });

          const moreHorizButtonVisible = await page.evaluate(() => {
            const button = document.evaluate(
              '//i[text()="more_horiz"]',
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue;
            return !!button;
          });

          if (moreHorizButtonVisible) {
            await page.evaluate(() => {
              document
                .evaluate(
                  '//i[text()="more_horiz"]',
                  document,
                  null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE,
                  null
                )
                .singleNodeValue.click();
            });
            pageLoaded = true;

            const titleText = await page.evaluate(() => {
              const h1Node = document.evaluate(
                '//*[@id="main"]/main/div/div/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div/div/h1',
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue;
              const spanNode = document.evaluate(
                '//*[@id="main"]/main/div/div/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div/div/h1/span',
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue;

              let h1Text = h1Node?.textContent.trim() || "";
              let spanText = spanNode?.textContent.trim() || "";

              if (h1Text === spanText) {
                spanText = "";
              }

              return `${h1Text} ${spanText}`.trim();
            });

            const links = await page.evaluate(() => {
              const allLinks = Array.from(document.querySelectorAll("a"));
              return allLinks.map((link) => link.href);
            });

            const relevantLinks = links.filter((link) => link.includes("discord"));
            if (relevantLinks.length > 0) {
              let textContent = "";
              for (const discordLink of relevantLinks) {
                collectionsWithDiscordLinks.push(`${titleText}:${discordLink}`);
                textContent += `${titleText}:${discordLink}\n`;
              }
            }
          }
        } catch (error) {
          console.error("Error opening link:", error);
          retries++;
          console.log(`Retrying (${retries}/${maxRetries})...`);
        }
      }

      if (!pageLoaded) {
        console.error(`Failed to load page after ${maxRetries} retries.`);
        continue;
      }
    }

    const invalidLinks = [];

    for (const collectionLink of collectionsWithDiscordLinks) {
      if (shouldStopScraping) {
        await ctx.reply("Scraping process has been stopped.");
        await browser.close();
        return;
      }

      console.log("Collection Link:", collectionLink);
      const httpsIndex = collectionLink.indexOf("https");
      if (httpsIndex === -1) {
        console.error("Invalid collection link format:", collectionLink);
        continue;
      }

      const collectionName = collectionLink.substring(0, httpsIndex).trim();
      const discordLink = collectionLink.substring(httpsIndex).trim();

      await page.goto(discordLink).catch((error) => {
        console.error("Error navigating to Discord link:", error);
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));

      console.log("Opening Discord Link:", discordLink);
      ctx.reply(`Opening Discord Link: <a href="${discordLink}">${collectionName}</a>`, { parse_mode: 'HTML' });

      const textOnPage = await page.evaluate(() => document.body.innerText);

      if (textOnPage.includes("invite invalid")) {
        let discordInvalid = "";
        invalidLinks.push(`${collectionName}: ${discordLink}`);
        discordInvalid += `${collectionName}:${discordLink}\n`;
        console.log("Invalid Discord Link found:", discordLink);
        ctx.reply(`Invalid Discord Link Found ${collectionName}:${discordLink}`);
      }
    }

    if (invalidLinks.length > 0) {
      console.log("Invalid Discord Links:");
      const textContent = invalidLinks.join('\n');

      const textFileBlob = new Blob([textContent], { type: 'text/plain' });
      const textFile = new InputFile(textFileBlob.stream(), 'invalidLinks.txt');

      await ctx.replyWithDocument(textFile);
      ctx.reply("Results file has been sent!");
    } else {
      console.log("No Invalid Links found");
    }

    await browser.close();
  } catch (error) {
    console.error("An error occurred:", error);
    ctx.reply(`An error occurred: ${error.message}`);
  }
}

bot.command("start", (ctx) => {
  console.log('/start command received');
  ctx.reply("Welcome! Up and running.");
});

bot.command("scrape", async (ctx) => {
  console.log('/scrape command received');
  shouldStopScraping = false;
  ctx.reply("Starting Scraping process");
  scraping(ctx);
});

bot.command("stop", async (ctx) => {
  console.log('/stop command received');
  shouldStopScraping = true;
  ctx.reply("Stopping Scraping process");
});

const app = express();
app.use(express.json());
app.use('/telegram-webhook', webhookCallback(bot, 'express'));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
