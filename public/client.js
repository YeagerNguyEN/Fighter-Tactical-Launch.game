document.addEventListener("DOMContentLoaded", () => {
  const socket = io();

  // --- DOM ELEMENTS ---
  const dom = {
    lobby: document.getElementById("lobby-container"),
    game: document.getElementById("game-container"),
    createRoomBtn: document.getElementById("create-room-btn"),
    joinRoomBtn: document.getElementById("join-room-btn"),
    roomCodeInput: document.getElementById("room-code-input"),
    roomCodeDisplay: document.getElementById("room-code-display"),
    infoPanel: document.getElementById("info-panel"),
    myPlaceBoard: document.getElementById("my-place-board"),
    opponentShootBoard: document.getElementById("opponent-shoot-board"),
    rotateButton: document.getElementById("rotate-button"),
    readyButton: document.getElementById("ready-button"),
    controlsArea: document.getElementById("controls-area"),
    placementTimerDisplay: document.getElementById("placement-timer"), // New DOM element for timer
    transition: {
      overlay: document.getElementById("transition-overlay"),
      title: document.getElementById("transition-title"),
      message: document.getElementById("transition-message"),
      button: document.getElementById("transition-button"),
    },
  };

  // --- GAME CONSTANTS ---
  const ROWS = 10;
  const COLS = 10;
  const PLANES_PER_PLAYER = 3;
  const DIRECTIONS = ["down", "left", "up", "right"];
  const BASE_PLANE_SHAPE = [
    [0, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [0, 2],
    [-1, 3],
    [0, 3],
    [1, 3],
  ];

  // --- GAME STATE ---
  let state;
  let placementCountdownInterval = null; // To hold the countdown interval

  function resetGame() {
    state = {
      roomCode: null,
      playerIndex: -1,
      placeBoard: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
      shootBoard: Array.from({ length: ROWS }, () => Array(COLS).fill(null)),
      planesPlaced: 0,
      phase: "LOBBY", // LOBBY, PLACE, SHOOT, GAMEOVER
      currentDirection: "down",
      lastHoveredCell: null,
      isMyTurn: false,
    };
    dom.lobby.style.display = "block";
    dom.game.style.display = "none";
    dom.roomCodeDisplay.textContent = "";
    dom.roomCodeInput.value = "";

    // Clear any existing timer when resetting
    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
    }
    dom.placementTimerDisplay.classList.add("hidden");
    console.log("[Client] Game state reset to LOBBY.");
  }

  // --- LOBBY LOGIC ---
  dom.createRoomBtn.addEventListener("click", () => {
    socket.emit("createRoom");
    console.log("[Client] Emitted 'createRoom'.");
  });
  dom.joinRoomBtn.addEventListener("click", () => {
    const roomCode = dom.roomCodeInput.value.toUpperCase();
    if (roomCode) {
      socket.emit("joinRoom", roomCode);
      console.log(`[Client] Emitted 'joinRoom' with code: ${roomCode}.`);
    }
  });

  socket.on("roomCreated", (roomCode) => {
    state.roomCode = roomCode;
    state.playerIndex = 0;
    dom.roomCodeDisplay.textContent = `Mã phòng: ${roomCode}. Đang chờ đối thủ...`;
    console.log(
      `[Client] Received 'roomCreated'. Room Code: ${roomCode}, Player Index: ${state.playerIndex}.`
    );
  });

  socket.on("gameStart", () => {
    dom.lobby.style.display = "none";
    dom.game.style.display = "flex";
    state.phase = "PLACE";
    initGameBoards();
    updateUI();
    console.log("[Client] Received 'gameStart'. Transitioning to PLACE phase.");
  });

  socket.on("error", (message) => {
    console.error(`[Client] Received error from server: ${message}`);
    showTransition("Lỗi", message);
  });

  // --- BOARD CREATION ---
  function initGameBoards() {
    createBoard(dom.myPlaceBoard, "place");
    createBoard(dom.opponentShootBoard, "shoot");
  }

  function createBoard(container, type) {
    container.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement("div");
        cell.classList.add("grid-cell");
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.dataset.type = type;
        container.appendChild(cell);
      }
    }
    container.addEventListener("mouseover", handleCellHover);
    container.addEventListener("mouseout", handleCellMouseOut);
    container.addEventListener("click", handleCellClick);
    console.log(`[Client] Board '${type}' created.`);
  }

  // --- GAME LOGIC & HELPERS ---
  function getRotatedShape(direction) {
    switch (direction) {
      case "down":
        return BASE_PLANE_SHAPE;
      case "left":
        return BASE_PLANE_SHAPE.map(([x, y]) => [-y, x]);
      case "up":
        return BASE_PLANE_SHAPE.map(([x, y]) => [-x, -y]);
      case "right":
        return BASE_PLANE_SHAPE.map(([x, y]) => [y, -x]);
      default:
        return BASE_PLANE_SHAPE;
    }
  }

  function canPlacePlane(board, row, col, shape) {
    for (const [dx, dy] of shape) {
      const r = row + dy;
      const c = col + dx;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== 0) {
        return false;
      }
    }
    return true;
  }

  function placePlaneOnBoard(board, row, col, shape) {
    board[row + shape[0][1]][col + shape[0][0]] = "H"; // Head
    for (let i = 1; i < shape.length; i++) {
      const [dx, dy] = shape[i];
      board[row + dy][col + dx] = "B"; // Body
    }
  }

  // --- EVENT HANDLERS ---
  dom.rotateButton.addEventListener("click", () => {
    const currentIndex = DIRECTIONS.indexOf(state.currentDirection);
    state.currentDirection = DIRECTIONS[(currentIndex + 1) % DIRECTIONS.length];
    if (state.lastHoveredCell) {
      const { r, c } = state.lastHoveredCell;
      clearPreview();
      drawPreview(r, c);
    }
    console.log(
      `[Client] Rotated plane. Current direction: ${state.currentDirection}.`
    );
  });

  dom.readyButton.addEventListener("click", () => {
    if (state.planesPlaced < PLANES_PER_PLAYER) {
      updateInfo(`Bạn cần đặt đủ ${PLANES_PER_PLAYER} máy bay.`);
      return;
    }
    state.phase = "WAITING";
    socket.emit("planesPlaced", {
      roomCode: state.roomCode,
      placeBoard: state.placeBoard,
    });
    // Clear timer if user readies up before timeout
    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
      dom.placementTimerDisplay.classList.add("hidden");
      console.log("[Client] Placement timer cleared due to player ready.");
    }
    updateUI();
    console.log(
      "[Client] Emitted 'planesPlaced'. Transitioned to WAITING phase."
    );
  });

  dom.transition.button.addEventListener("click", () => {
    dom.transition.overlay.classList.add("hidden");
    dom.transition.overlay.classList.remove("flex"); // Ensure flex is removed
    if (state.phase === "GAMEOVER") {
      resetGame();
      // Using location.reload() for a full reset.
      // In a more complex app, you might navigate or clear state without reload.
      location.reload();
    }
    console.log("[Client] Transition button clicked. Overlay hidden.");
  });

  function handleCellClick(e) {
    const cell = e.target.closest(".grid-cell");
    if (!cell) return;
    const r = parseInt(cell.dataset.row);
    const c = parseInt(cell.dataset.col);
    const type = cell.dataset.type;

    console.log(
      `[Client] Cell clicked: [${r}, ${c}], type: ${type}, phase: ${state.phase}, isMyTurn: ${state.isMyTurn}`
    );

    if (state.phase === "PLACE" && type === "place") {
      const shape = getRotatedShape(state.currentDirection);
      if (canPlacePlane(state.placeBoard, r, c, shape)) {
        placePlaneOnBoard(state.placeBoard, r, c, shape);
        state.planesPlaced++;
        clearPreview();
        updateUI();
        console.log(
          `[Client] Plane placed at [${r}, ${c}]. Planes placed: ${state.planesPlaced}.`
        );
      } else {
        console.log(
          `[Client] Cannot place plane at [${r}, ${c}]. Invalid position or occupied.`
        );
      }
    } else if (state.phase === "SHOOT" && type === "shoot" && state.isMyTurn) {
      if (state.shootBoard[r][c] === null) {
        socket.emit("shoot", { roomCode: state.roomCode, row: r, col: c });
        console.log(`[Client] Emitted 'shoot' at [${r}, ${c}].`);
      } else {
        console.log(
          `[Client] Cell [${r}, ${c}] already shot. Cannot shoot again.`
        );
      }
    } else if (state.phase === "SHOOT" && !state.isMyTurn) {
      console.log("[Client] Not your turn to shoot.");
    } else if (state.phase !== "SHOOT" && type === "shoot") {
      console.log("[Client] Not in SHOOT phase yet.");
    }
  }

  function handleCellHover(e) {
    const cell = e.target.closest(".grid-cell");
    if (!cell || state.phase !== "PLACE" || cell.dataset.type !== "place")
      return;
    const r = parseInt(cell.dataset.row);
    const c = parseInt(cell.dataset.col);
    state.lastHoveredCell = { r, c };
    drawPreview(r, c);
  }

  function handleCellMouseOut() {
    clearPreview();
    state.lastHoveredCell = null;
  }

  // --- SERVER EVENT HANDLERS ---
  socket.on("placementTimerStarted", (timeLimit) => {
    let timeLeft = timeLimit / 1000; // Convert ms to seconds
    dom.placementTimerDisplay.classList.remove("hidden");
    dom.placementTimerDisplay.textContent = `Thời gian đặt: ${timeLeft}s`;

    console.log(
      `[Client] Received 'placementTimerStarted' with ${timeLeft} seconds.`
    );

    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
    }

    placementCountdownInterval = setInterval(() => {
      timeLeft--;
      dom.placementTimerDisplay.textContent = `Thời gian đặt: ${timeLeft}s`;
      if (timeLeft <= 0) {
        clearInterval(placementCountdownInterval);
        placementCountdownInterval = null;
        dom.placementTimerDisplay.classList.add("hidden");
        console.log("[Client] Placement timer finished.");
      }
    }, 1000);
  });

  socket.on("opponentReady", () => {
    showTransition(
      "Đối Thủ Đã Sẵn Sàng",
      "Đối thủ của bạn đã đặt xong máy bay. Hãy nhanh lên!"
    );
    console.log("[Client] Received 'opponentReady'.");
  });

  socket.on("shootingPhaseStart", () => {
    state.phase = "SHOOT";
    // Clear the timer if it's still running when phase starts
    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
    }
    dom.placementTimerDisplay.classList.add("hidden");
    showTransition(
      "Trận Chiến Bắt Đầu!",
      "Lượt bắn sẽ được quyết định ngay sau đây."
    );
    updateUI();
    console.log(
      "[Client] Received 'shootingPhaseStart'. Transitioned to SHOOT phase."
    );
  });

  socket.on("newTurn", (turnIndex) => {
    state.isMyTurn = state.playerIndex === turnIndex;
    updateUI();
    console.log(
      `[Client] Received 'newTurn'. My turn: ${state.isMyTurn} (Player ${state.playerIndex}, Turn Index: ${turnIndex}).`
    );
  });

  socket.on("shotResult", ({ shooterIndex, row, col, result }) => {
    const isMyShot = shooterIndex === state.playerIndex;
    // Turn is swapped by server, so client just updates board
    // state.isMyTurn is updated by 'newTurn' event that follows this

    if (isMyShot) {
      // It was my shot, update my shoot board
      state.shootBoard[row][col] = result;
      console.log(
        `[Client] My shot at [${row}, ${col}] resulted in: ${result}.`
      );
    } else {
      // Opponent's shot, update my place board
      state.placeBoard[row][col] = result;
      console.log(
        `[Client] Opponent shot at [${row}, ${col}] resulted in: ${result}.`
      );
    }
    updateUI();
  });

  socket.on("gameOver", (winnerIndex) => {
    state.phase = "GAMEOVER";
    const message =
      winnerIndex === state.playerIndex
        ? "Bạn đã chiến thắng!"
        : "Bạn đã thua cuộc.";
    showTransition("TRÒ CHƠI KẾT THÚC", message, "Chơi Lại");
    updateUI();
    console.log(`[Client] Received 'gameOver'. Winner Index: ${winnerIndex}.`);
  });

  socket.on("opponentLeft", () => {
    if (state.phase !== "GAMEOVER") {
      showTransition(
        "Đối Thủ Đã Thoát",
        "Bạn đã thắng do đối thủ thoát giữa chừng.",
        "Về Sảnh"
      );
      state.phase = "GAMEOVER"; // Force game over state
    }
    // Clear timer if opponent leaves
    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
      dom.placementTimerDisplay.classList.add("hidden");
    }
    updateUI(); // Update UI to reflect game over state
    console.log("[Client] Received 'opponentLeft'.");
  });

  // --- PREVIEW & UI ---
  function drawPreview(row, col) {
    const shape = getRotatedShape(state.currentDirection);
    const isValid = canPlacePlane(state.placeBoard, row, col, shape);
    for (const [dx, dy] of shape) {
      const r = row + dy,
        c = col + dx;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        const cell = dom.myPlaceBoard.querySelector(
          `[data-row='${r}'][data-col='${c}']`
        );
        if (cell)
          cell.classList.add(
            isValid ? "cell-preview-valid" : "cell-preview-invalid"
          );
      }
    }
  }
  function clearPreview() {
    document
      .querySelectorAll(".grid-cell")
      .forEach((c) =>
        c.classList.remove("cell-preview-valid", "cell-preview-invalid")
      );
  }

  function updateInfo(text) {
    dom.infoPanel.textContent = text;
    dom.infoPanel.classList.remove("fade-in");
    void dom.infoPanel.offsetWidth; // Trigger reflow to restart animation
    dom.infoPanel.classList.add("fade-in");
  }

  function showTransition(title, message, buttonText = "OK") {
    dom.transition.title.textContent = title;
    dom.transition.message.textContent = message;
    dom.transition.button.textContent = buttonText;
    dom.transition.overlay.classList.remove("hidden");
    dom.transition.overlay.classList.add("flex");
  }

  function renderBoard(container, boardData, type) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = container.querySelector(
          `[data-row='${r}'][data-col='${c}']`
        );
        if (!cell) continue;
        cell.className = "grid-cell"; // Reset all classes
        cell.dataset.type = type; // Ensure type is set correctly
        const val = boardData[r][c];

        if (type === "place") {
          // My board (where I place planes)
          if (val === "H") cell.classList.add("cell-head");
          else if (val === "B") cell.classList.add("cell-placed");
          // After a shot from opponent, my board cells change to 'D', 'I', or 'M'
          else if (val === "D")
            cell.classList.add("cell-hit-head"); // Hit (Destroyed head)
          else if (val === "I")
            cell.classList.add("cell-hit-body"); // Hit (Impact body)
          else if (val === "M") cell.classList.add("cell-miss"); // Miss
        } else {
          // Opponent's board (where I shoot)
          if (val === "D")
            cell.classList.add("cell-hit-head"); // My shot hit head
          else if (val === "I")
            cell.classList.add("cell-hit-body"); // My shot hit body
          else if (val === "M") cell.classList.add("cell-miss"); // My shot missed
        }
      }
    }
  }

  function updateUI() {
    renderBoard(dom.myPlaceBoard, state.placeBoard, "place");
    renderBoard(dom.opponentShootBoard, state.shootBoard, "shoot");

    // Controls visibility
    dom.controlsArea.style.display = state.phase === "PLACE" ? "flex" : "none";
    dom.readyButton.style.display =
      state.planesPlaced >= PLANES_PER_PLAYER ? "block" : "none";

    // Cursor management
    dom.myPlaceBoard.style.cursor =
      state.phase === "PLACE" ? "pointer" : "default";
    dom.opponentShootBoard.style.cursor =
      state.phase === "SHOOT" && state.isMyTurn && dom.shootBoard[0][0] === null // Only allow clicking if cell hasn't been shot
        ? "crosshair" // Indicate clickable target
        : "default"; // Default cursor

    // Info panel messages
    switch (state.phase) {
      case "PLACE":
        updateInfo(
          `Hãy đặt máy bay ${state.planesPlaced}/${PLANES_PER_PLAYER}. Xoay và click để đặt.`
        );
        break;
      case "WAITING":
        updateInfo("Đang chờ đối thủ đặt máy bay...");
        break;
      case "SHOOT":
        updateInfo(
          state.isMyTurn
            ? "Lượt của bạn! Hãy tấn công một ô trên bàn đối thủ."
            : "Lượt của đối thủ. Xin chờ..."
        );
        break;
      case "GAMEOVER":
        updateInfo("TRÒ CHƠI KẾT THÚC!");
        break;
      default:
        updateInfo(""); // Clear info for LOBBY
    }
    console.log(
      `[Client] UI Updated. Phase: ${state.phase}, Is My Turn: ${state.isMyTurn}, Planes Placed: ${state.planesPlaced}`
    );
  }

  // --- INITIALIZE GAME ---
  resetGame();
});
