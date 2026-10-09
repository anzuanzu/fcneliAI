import {simulateFcn} from './fcn-model.mjs';

self.onmessage = async ({data}) => {
  try {
    for (const months of [3, 4, 5, 6]) {
      self.postMessage({type: 'term', months});
      try {
        const result = await simulateFcn({...data, months,
          onProgress: progress => self.postMessage({type: 'progress', months, progress})});
        self.postMessage({type: 'result', months, result});
      } catch (error) {
        self.postMessage({type: 'result', months, error: error.message});
      }
    }
    self.postMessage({type: 'complete'});
  } catch (error) {
    self.postMessage({type: 'error', error: error.message});
  }
};
