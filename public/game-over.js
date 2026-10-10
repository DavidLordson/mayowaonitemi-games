// The full-page "<name> won" screen shown when a board game ends.
// Ludo and Whot both drop `gameOverHtml` into their markup and drive it with `gameOver()`.
//
// "Play again" restarts the same game straight away (the server rotates the seats, so the
// colours swap over); "Other games" goes back to the lobby.

export const gameOverHtml = `
  <div class="game-over" hidden>
    <div class="go-card">
      <div class="go-emoji"></div>
      <p class="go-title"></p>
      <p class="go-sub"></p>
      <button type="button" class="primary go-again">Play again</button>
      <button type="button" class="go-games">Other games</button>
    </div>
  </div>`;

// ctx: { playAgain({ vsComputer }), newGame() }. Returns a draw function: pass null while the
// game is still on, or { youWon, name, vsComputer, note } once it's over.
export function gameOver(root, ctx) {
  const el = root.querySelector(".game-over");
  const emoji = el.querySelector(".go-emoji");
  const title = el.querySelector(".go-title");
  const sub = el.querySelector(".go-sub");
  const again = el.querySelector(".go-again");
  let opts = { vsComputer: false };

  again.onclick = () => {
    again.disabled = true;
    again.textContent = "Starting…";
    ctx.playAgain(opts);
  };
  el.querySelector(".go-games").onclick = () => ctx.newGame();

  return (result) => {
    if (!result) {
      el.hidden = true;
      return;
    }
    if (el.hidden) { // arriving on the screen: the button is ready again
      again.disabled = false;
      again.textContent = "Play again";
      el.hidden = false;
    }
    opts = { vsComputer: !!result.vsComputer, noSafe: !!result.noSafe };
    emoji.textContent = result.youWon ? "🎉" : result.vsComputer ? "🤖" : "🏆";
    title.textContent = result.youWon ? "You won!" : `${result.name} won`;
    sub.textContent = result.note || (result.youWon ? "Well played." : "Play again — the colours swap over.");
  };
}
