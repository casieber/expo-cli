import { getConfig } from '@expo/config';
import { User, UserManager } from '@expo/xdl';

import { EasConfig } from '../../../easJson';
import { BuildCommandPlatform, BuilderContext } from '../types';

export default async function createBuilderContextAsync(
  projectDir: string,
  eas: EasConfig,
  {
    platform = BuildCommandPlatform.ALL,
    nonInteractive = false,
    skipCredentialsCheck = false,
    skipProjectConfiguration = false,
  }: {
    platform?: BuildCommandPlatform;
    nonInteractive?: boolean;
    skipCredentialsCheck?: boolean;
    skipProjectConfiguration?: boolean;
  }
): Promise<BuilderContext> {
  const user: User = await UserManager.ensureLoggedInAsync();
  const { exp } = getConfig(projectDir, { skipSDKVersionRequirement: true });
  const accountName = exp.owner || user.username;
  const projectName = exp.slug;

  return {
    eas,
    projectDir,
    user,
    accountName,
    projectName,
    exp,
    platform,
    nonInteractive,
    skipCredentialsCheck,
    skipProjectConfiguration,
  };
}
