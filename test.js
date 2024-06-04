import BoardController from './controller.js';

let bc = new BoardController();
while (true) {
    bc.runToNextInterrupt();
    console.log (bc.board.i, bc.board.j, bc.board.cycles)
}
