import { Job, Platform } from '@expo/build-tools';
import { ExpoConfig } from '@expo/config';
import { User } from '@expo/xdl';

import { EasConfig } from '../../easJson';

export enum BuildCommandPlatform {
  ANDROID = 'android',
  IOS = 'ios',
  ALL = 'all',
}

export enum BuildStatus {
  IN_QUEUE = 'in-queue',
  IN_PROGRESS = 'in-progress',
  ERRORED = 'errored',
  FINISHED = 'finished',
}

export interface Build {
  id: string;
  status: BuildStatus;
  platform: Platform;
  createdAt: string;
  artifacts?: BuildArtifacts;
}

interface BuildArtifacts {
  buildUrl?: string;
  logsUrl: string;
}

export interface Builder {
  ctx: BuilderContext;
  setupAsync(): Promise<void>;
  ensureCredentialsAsync(): Promise<void>;
  ensureProjectConfiguredAsync(): Promise<void>;
  prepareJobAsync(archiveUrl: string): Promise<Job>;
}

export interface BuilderContext {
  projectDir: string;
  eas: EasConfig;
  user: User;
  accountName: string;
  projectName: string;
  exp: ExpoConfig;
  platform: BuildCommandPlatform;
  nonInteractive: boolean;
  skipCredentialsCheck: boolean;
  skipProjectConfiguration: boolean;
}
