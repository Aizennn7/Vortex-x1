export * from './types.js';
export * from './twelvedata.js';
export * from './simulator.js';

import { SimulatedProvider } from './simulator.js';
import { TwelveDataProvider, type TwelveDataOptions } from './twelvedata.js';
import type { MarketDataProvider } from './types.js';

export interface ProviderFactoryOptions extends TwelveDataOptions {
  provider: 'twelvedata' | 'simulated';
  simulator?: ConstructorParameters<typeof SimulatedProvider>[0];
}

export function createProvider(options: ProviderFactoryOptions): MarketDataProvider {
  if (options.provider === 'simulated') return new SimulatedProvider(options.simulator ?? {});
  return new TwelveDataProvider(options);
}
