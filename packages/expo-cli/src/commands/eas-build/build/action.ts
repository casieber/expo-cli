import { Platform } from '@expo/build-tools';
import { getConfig } from '@expo/config';
import { ApiV2, User, UserManager } from '@expo/xdl';
import chalk from 'chalk';
import delayAsync from 'delay-async';
import fs from 'fs-extra';
import ora from 'ora';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { EasConfig, EasJsonReader } from '../../../easJson';
import log from '../../../log';
import { ensureProjectExistsAsync } from '../../../projects';
import { UploadType, uploadAsync } from '../../../uploads';
import { createProgressTracker } from '../../utils/progress';
import { platformDisplayNames } from '../constants';
import { Build, BuildCommandPlatform, BuildStatus } from '../types';
import AndroidBuilder from './builders/AndroidBuilder';
import iOSBuilder from './builders/iOSBuilder';
import { BuildMetadata, collectMetadata } from './metadata';
import { Builder, BuilderContext, CommandContext, PlatformBuildProfile } from './types';
import {
  ensureGitRepoExistsAsync,
  ensureGitStatusIsCleanAsync,
  makeProjectTarballAsync,
} from './utils/git';
import { printBuildResults, printLogsUrls } from './utils/misc';

interface BuildOptions {
  platform: BuildCommandPlatform;
  skipCredentialsCheck?: boolean; // TODO: noop for now
  skipProjectConfiguration?: boolean;
  wait?: boolean;
  profile: string;
  parent?: {
    nonInteractive: boolean;
  };
}

async function buildAction(projectDir: string, options: BuildOptions): Promise<void> {
  const buildCommandPlatforms = Object.values(BuildCommandPlatform);

  const { platform: requestedPlatform, profile } = options;
  if (!requestedPlatform || !buildCommandPlatforms.includes(requestedPlatform)) {
    throw new Error(
      `-p/--platform is required, valid platforms: ${buildCommandPlatforms
        .map(p => log.chalk.bold(p))
        .join(', ')}`
    );
  }

  await ensureGitRepoExistsAsync();
  await ensureGitStatusIsCleanAsync();

  const commandCtx = await createCommandContextAsync({
    requestedPlatform,
    profile,
    projectDir,
    nonInteractive: options.parent?.nonInteractive,
    skipCredentialsCheck: options?.skipCredentialsCheck,
    skipProjectConfiguration: options?.skipProjectConfiguration,
  });

  const projectId = await ensureProjectExistsAsync(commandCtx.user, {
    accountName: commandCtx.accountName,
    projectName: commandCtx.projectName,
  });
  const scheduledBuilds = await startBuildsAsync(commandCtx, projectId);
  log.newLine();
  await printLogsUrls(commandCtx.accountName, scheduledBuilds);
  log.newLine();

  if (options.wait) {
    const builds = await waitForBuildEndAsync(
      commandCtx,
      projectId,
      scheduledBuilds.map(i => i.buildId)
    );
    printBuildResults(builds);
  }
}

async function createCommandContextAsync({
  requestedPlatform,
  profile,
  projectDir,
  nonInteractive = false,
  skipCredentialsCheck = false,
  skipProjectConfiguration = false,
}: {
  requestedPlatform: BuildCommandPlatform;
  profile: string;
  projectDir: string;
  nonInteractive?: boolean;
  skipCredentialsCheck?: boolean;
  skipProjectConfiguration?: boolean;
}): Promise<CommandContext> {
  const user: User = await UserManager.ensureLoggedInAsync();
  const { exp } = getConfig(projectDir, { skipSDKVersionRequirement: true });
  const accountName = exp.owner || user.username;
  const projectName = exp.slug;

  return {
    requestedPlatform,
    profile,
    projectDir,
    user,
    accountName,
    projectName,
    exp,
    nonInteractive,
    skipCredentialsCheck,
    skipProjectConfiguration,
  };
}

async function startBuildsAsync(
  commandCtx: CommandContext,
  projectId: string
): Promise<
  { platform: BuildCommandPlatform.ANDROID | BuildCommandPlatform.IOS; buildId: string }[]
> {
  const client = ApiV2.clientForUser(commandCtx.user);
  const scheduledBuilds: {
    platform: BuildCommandPlatform.ANDROID | BuildCommandPlatform.IOS;
    buildId: string;
  }[] = [];
  const easConfig = await new EasJsonReader(
    commandCtx.projectDir,
    commandCtx.requestedPlatform
  ).readAsync(commandCtx.profile);
  if (
    [BuildCommandPlatform.ANDROID, BuildCommandPlatform.ALL].includes(commandCtx.requestedPlatform)
  ) {
    const builderContext = createBuilderContext<Platform.Android>({
      commandCtx,
      platform: Platform.Android,
      easConfig,
    });
    const builder = new AndroidBuilder(builderContext);
    const buildId = await startBuildAsync(client, { builder, projectId });
    scheduledBuilds.push({ platform: BuildCommandPlatform.ANDROID, buildId });
  }
  if ([BuildCommandPlatform.IOS, BuildCommandPlatform.ALL].includes(commandCtx.requestedPlatform)) {
    const builderContext = createBuilderContext<Platform.iOS>({
      commandCtx,
      platform: Platform.iOS,
      easConfig,
    });
    const builder = new iOSBuilder(builderContext);
    const buildId = await startBuildAsync(client, { builder, projectId });
    scheduledBuilds.push({ platform: BuildCommandPlatform.IOS, buildId });
  }
  return scheduledBuilds;
}

function createBuilderContext<T extends Platform>({
  platform,
  easConfig,
  commandCtx,
}: {
  platform: T;
  easConfig: EasConfig;
  commandCtx: CommandContext;
}): BuilderContext<T> {
  const buildProfile = easConfig.builds[platform] as PlatformBuildProfile<T> | undefined;
  if (!buildProfile) {
    throw new Error(`${platform} build profile does not exist`);
  }

  return {
    commandCtx,
    platform,
    buildProfile,
  };
}

async function startBuildAsync<T extends Platform>(
  client: ApiV2,
  {
    projectId,
    builder,
  }: {
    projectId: string;
    builder: Builder<T>;
  }
): Promise<string> {
  const tarPath = path.join(os.tmpdir(), `${uuidv4()}.tar.gz`);
  try {
    await builder.setupAsync();
    const credentialsSource = await builder.ensureCredentialsAsync();
    if (!builder.ctx.commandCtx.skipProjectConfiguration) {
      await builder.configureProjectAsync();
    }

    const fileSize = await makeProjectTarballAsync(tarPath);

    log('Uploading project to AWS S3');
    const archiveUrl = await uploadAsync(
      UploadType.TURTLE_PROJECT_SOURCES,
      tarPath,
      createProgressTracker(fileSize)
    );

    const metadata = await collectMetadata(builder.ctx.commandCtx, {
      buildProfile: builder.ctx.buildProfile,
      credentialsSource,
    });
    const job = await builder.prepareJobAsync(archiveUrl);
    log(`Starting ${platformDisplayNames[job.platform]} build`);
    const { buildId } = await client.postAsync(`projects/${projectId}/builds`, {
      job: job as any,
      metadata,
    });
    return buildId;
  } finally {
    await fs.remove(tarPath);
  }
}

async function waitForBuildEndAsync(
  commandCtx: CommandContext,
  projectId: string,
  buildIds: string[],
  { timeoutSec = 1800, intervalSec = 30 } = {}
): Promise<(Build | null)[]> {
  const client = ApiV2.clientForUser(commandCtx.user);
  log('Waiting for build to complete. You can press Ctrl+C to exit.');
  const spinner = ora().start();
  let time = new Date().getTime();
  const endTime = time + timeoutSec * 1000;
  while (time <= endTime) {
    const builds: (Build | null)[] = await Promise.all(
      buildIds.map(buildId => {
        try {
          return client.getAsync(`projects/${projectId}/builds/${buildId}`);
        } catch (err) {
          return null;
        }
      })
    );
    if (builds.length === 1) {
      switch (builds[0]?.status) {
        case BuildStatus.FINISHED:
          spinner.succeed('Build finished.');
          return builds;
        case BuildStatus.IN_QUEUE:
          spinner.text = 'Build queued...';
          break;
        case BuildStatus.IN_PROGRESS:
          spinner.text = 'Build in progress...';
          break;
        case BuildStatus.ERRORED:
          spinner.fail('Build failed.');
          throw new Error(`Standalone build failed!`);
        default:
          spinner.warn('Unknown status.');
          throw new Error(`Unknown status: ${builds} - aborting!`);
      }
    } else {
      if (builds.filter(build => build?.status === BuildStatus.FINISHED).length === builds.length) {
        spinner.succeed('All build have finished.');
        return builds;
      } else if (
        builds.filter(build =>
          build?.status ? [BuildStatus.FINISHED, BuildStatus.ERRORED].includes(build.status) : false
        ).length === builds.length
      ) {
        spinner.fail('Some of the builds failed.');
        return builds;
      } else {
        const inQueue = builds.filter(build => build?.status === BuildStatus.IN_QUEUE).length;
        const inProgress = builds.filter(build => build?.status === BuildStatus.IN_PROGRESS).length;
        const errored = builds.filter(build => build?.status === BuildStatus.ERRORED).length;
        const finished = builds.filter(build => build?.status === BuildStatus.FINISHED).length;
        const unknownState = builds.length - inQueue - inProgress - errored - finished;
        spinner.text = [
          inQueue && `Builds in queue: ${inQueue}`,
          inProgress && `Builds in progress: ${inProgress}`,
          errored && chalk.red(`Builds failed: ${errored}`),
          finished && chalk.green(`Builds finished: ${finished}`),
          unknownState && chalk.red(`Builds in unknown state: ${unknownState}`),
        ]
          .filter(i => i)
          .join('\t');
      }
    }
    time = new Date().getTime();
    await delayAsync(intervalSec * 1000);
  }
  spinner.warn('Timed out.');
  throw new Error(
    'Timeout reached! It is taking longer than expected to finish the build, aborting...'
  );
}

export default buildAction;
