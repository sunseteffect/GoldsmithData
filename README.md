# Goldsmith Data

Price data for [Goldsmith](https://github.com/sunseteffect/Goldsmith), the crafting profit planner for World of Warcraft.

Goldsmith installs this for you as a required dependency. It has no window or settings: it gives Goldsmith auction house prices for your region (US, EU, KR or TW), so profits and suggestions work even without TSM or Auctionator. New data arrives with each daily update and loads when you log in or `/reload`.

## How it's made

A GitHub Actions workflow runs every hour:

1. `tools/fetch.js` downloads each region's commodity auctions from the Blizzard Game Data API and works out, per item, the lowest price, the market price (average of the cheapest 15% of units), the median and the units listed. It also compares the listings with the previous hour's to estimate what sold (kept for sales history; not shipped yet).
2. Once a day, `tools/release.js` packages the four region files and uploads a new version to CurseForge.

Each region's file only builds its table when you play in that region, so the others cost almost nothing.

## Running it yourself

Needs Node.js 18 or newer and a Blizzard API client (free, from https://develop.battle.net).

    BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=... node tools/fetch.js --regions us

On Windows, `tools/run-local.ps1 -SetCredentials` stores the client once and `tools/run-local.ps1` fetches into this folder; `-Install` adds an hourly scheduled task.
