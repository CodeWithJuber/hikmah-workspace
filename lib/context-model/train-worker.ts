import {trainReviewed} from './training.ts';
self.onmessage=event=>{try{const {base,rows,released}=event.data;self.postMessage({stage:'Fitting lexical, sequence and dependency factors'});const value=trainReviewed(base,rows,released);self.postMessage({done:true,value});}catch(e){self.postMessage({error:e instanceof Error?e.message:'Training failed.'});}};
