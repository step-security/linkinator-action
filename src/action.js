import core from '@actions/core';
import { LinkChecker, LinkState, getConfig } from 'linkinator';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import axios from 'axios';

export async function getFullConfig () {
  const defaults = {
    path: ['*.md'],
    concurrency: 100,
    recurse: false,
    skip: [],
    timeout: 0,
    markdown: true,
    retry: false,
    verbosity: 'WARNING'
  };
  // The options returned from `getInput` appear to always be strings.
  const actionsConfig = {
    path: parseList('paths'),
    concurrency: parseNumber('concurrency'),
    recurse: parseBoolean('recurse'),
    skip: parseList('linksToSkip') || parseList('skip'),
    timeout: parseNumber('timeout'),
    markdown: parseBoolean('markdown'),
    serverRoot: parseString('serverRoot'),
    directoryListing: parseBoolean('directoryListing'),
    retry: parseBoolean('retry'),
    verbosity: parseString('verbosity'),
    config: parseString('config')
  };
  const urlRewriteSearch = parseString('urlRewriteSearch');
  const urlRewriteReplace = parseString('urlRewriteReplace');
  actionsConfig.urlRewriteExpressions = [];
  if (urlRewriteSearch && urlRewriteReplace) {
    actionsConfig.urlRewriteExpressions.push(
      {
        pattern: urlRewriteSearch,
        replacement: urlRewriteReplace
      }
    );
  }
  const fileConfig = await getConfig(actionsConfig);
  const config = Object.assign({}, defaults, fileConfig);
  config.linksToSkip = config.skip;
  return config;
}

async function validateSubscription () {
  let repoPrivate;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fsSync.existsSync(eventPath)) {
    const payload = JSON.parse(fsSync.readFileSync(eventPath, "utf8"));
    repoPrivate = payload?.repository?.private;
  }

  const upstream = "JustinBeckwith/linkinator-action";
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl =
    "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false)
    core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) return;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const body = { action: action || "" };

  if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      );
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

export async function main () {
  try {
    await validateSubscription();
    const config = await getFullConfig();
    const verbosity = getVerbosity(config.verbosity);
    const logger = new Logger(verbosity);
    const { GITHUB_HEAD_REF, GITHUB_BASE_REF, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;
    // Read pull_request payload and use it to determine head user/repo:
    if (GITHUB_EVENT_PATH) {
      try {
        const payloadRaw = await fs.readFile(GITHUB_EVENT_PATH, 'utf8');
        const payload = JSON.parse(payloadRaw);
        if (payload?.pull_request?.head) {
          const repo = payload.pull_request.head.repo.full_name;
          core.info(`rewrite repo to ${repo}`);
          if (!config.urlRewriteExpressions) {
            config.urlRewriteExpressions = [];
          }
          config.urlRewriteExpressions.push({
            pattern: new RegExp(`github.com/${GITHUB_REPOSITORY}(/.*/)(${GITHUB_BASE_REF})/(.*)`),
            replacement: `github.com/${repo}$1${GITHUB_HEAD_REF}/$3`
          });
        }
      } catch (err) {
        core.warning(err);
      }
    }

    const checker = new LinkChecker()
      .on('link', link => {
        switch (link.state) {
          case LinkState.BROKEN:
            logger.error(`[${link.status.toString()}] ${link.url}`);
            break;
          case LinkState.OK:
            logger.warn(`[${link.status.toString()}] ${link.url}`);
            break;
          case LinkState.SKIPPED:
            logger.info(`[SKP] ${link.url}`);
            break;
        }
      })
      .on('retry', retryInfo => {
        logger.info('[RETRY]', retryInfo);
      });
    core.info(`Scanning ${config.path.join(', ')}`);
    const result = await checker.check(config);
    const nonSkippedLinks = result.links.filter(x => x.state !== 'SKIPPED');
    core.info(`Scanned total of ${nonSkippedLinks.length} links!`);
    if (!result.passed) {
      const brokenLinks = result.links.filter(x => x.state === 'BROKEN');
      let failureOutput = `Detected ${brokenLinks.length} broken links.`;

      // build a map of failed links by the parent document
      const parents = brokenLinks.reduce((acc, curr) => {
        const parent = curr.parent || '';
        if (!acc[parent]) {
          acc[parent] = [];
        }
        acc[parent].push(curr);
        return acc;
      }, {});

      for (const parent of Object.keys(parents)) {
        failureOutput += `\n ${parent}`;
        for (const link of parents[parent]) {
          failureOutput += `\n   [${link.status}] ${link.url}`;
          logger.debug(JSON.stringify(link.failureDetails, null, 2));
        }
      }
      core.setFailed(failureOutput);
    }
    core.setOutput('results', result);
  } catch (err) {
    core.setFailed(`Linkinator exception: \n${err.message}\n${err.stack}`);
  }
}

function parseString (input) {
  return core.getInput(input) || undefined;
}

function parseList (input) {
  const value = core.getInput(input) || undefined;
  if (value) {
    return value.split(/[\s,]+/).map(x => x.trim()).filter(x => !!x);
  }
  return undefined;
}

function parseNumber (input) {
  const value = core.getInput(input) || undefined;
  if (value) {
    return Number(value);
  }
  return undefined;
}

function parseBoolean (input) {
  const value = core.getInput(input) || undefined;
  if (value) {
    return Boolean(value);
  }
  return undefined;
}

function getVerbosity (verbosity) {
  verbosity = verbosity.toUpperCase();
  const options = Object.keys(LogLevel);
  if (!options.includes(verbosity)) {
    throw new Error(
      `Invalid flag: VERBOSITY must be one of [${options.join(',')}]`
    );
  }
  return LogLevel[verbosity];
}

const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  NONE: 4
};

class Logger {
  constructor (level) {
    this.level = level;
  }

  debug (message) {
    if (this.level <= LogLevel.DEBUG) {
      core.info(message);
    }
  }

  info (message) {
    if (this.level <= LogLevel.INFO) {
      core.info(message);
    }
  }

  warn (message) {
    if (this.level <= LogLevel.WARNING) {
      core.info(message);
    }
  }

  error (message) {
    if (this.level <= LogLevel.ERROR) {
      core.error(message);
    }
  }
}
