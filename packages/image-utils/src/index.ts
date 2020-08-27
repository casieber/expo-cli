import * as Cache from './Cache';
import { generateFaviconAsync, generateImageAsync, layerImageAsync } from './Image';
import { ImageFormat, ImageOptions, ResizeMode } from './Image.types';
import { convertFormat, jimpAsync } from './jimp';
import { findSharpInstanceAsync, isAvailableAsync, sharpAsync } from './sharp';
import { SharpCommandOptions, SharpGlobalOptions } from './sharp.types';

export async function imageAsync(
  options: SharpGlobalOptions,
  commands: SharpCommandOptions[] = []
) {
  if (await isAvailableAsync()) {
    return sharpAsync(options, commands);
  }
  return jimpAsync(
    { ...options, format: convertFormat(options.format), originalInput: options.input },
    commands
  );
}

export {
  jimpAsync,
  findSharpInstanceAsync,
  isAvailableAsync,
  sharpAsync,
  generateImageAsync,
  generateFaviconAsync,
  Cache,
  layerImageAsync,
};

export { SharpGlobalOptions, SharpCommandOptions, ResizeMode, ImageFormat, ImageOptions };
