import BoardController from './controller.js';

async function log() {
    while (true) {
        console.log ('i='+bc.board.iOrig, 'j='+bc.board.jOrig, 'nextCycles='+bc.board.nextCycles)
        await sleep(1000);
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
}

let bc = new BoardController();
bc.randomize();
bc.setUpdater();

log();
