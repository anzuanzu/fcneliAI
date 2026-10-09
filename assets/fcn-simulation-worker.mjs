import {simulateFcn} from './fcn-model.mjs';

self.onmessage = async ({data}) => {
  try {
    const scenarios = data.mode === 'historical-estimate' ? ['low', 'base', 'high'] : [undefined];
    for (const scenario of scenarios) for (const months of [3, 4, 5, 6]) {
      self.postMessage({type: 'term', months, scenario});
      try {
        const result = await simulateFcn({...data, months, ...(scenario ? {scenario} : {}),
          onProgress: progress => self.postMessage({type: 'progress', months, scenario, progress})});
        self.postMessage({type: 'result', months, scenario, result});
      } catch (error) {
        self.postMessage({type: 'result', months, scenario, error: error.message});
      }
    }
    self.postMessage({type: 'complete'});
  } catch (error) {
    self.postMessage({type: 'error', error: error.message});
  }
};
