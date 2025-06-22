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
    placementTimerDisplay: document.getElementById("placement-timer"),
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
    [0, 0], // Head relative to its own position
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
  let placementCountdownInterval = null;

  function resetGame() {
    state = {
      roomCode: null,
      playerIndex: -1, // Will be 0 or 1
      placeBoard: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
      shootBoard: Array.from({ length: ROWS }, () => Array(COLS).fill(null)), // Represents opponent's board from player's perspective
      planesPlaced: 0,
      phase: "LOBBY", // LOBBY, PLACE, SHOOT, GAMEOVER
      currentDirection: "down",
      lastHoveredCell: null,
      isMyTurn: false, // Crucial for shooting phase
    };
    dom.lobby.style.display = "block";
    dom.game.style.display = "none";
    dom.roomCodeDisplay.textContent = "";
    dom.roomCodeInput.value = "";

    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
    }
    dom.placementTimerDisplay.classList.add("hidden");
    dom.transition.overlay.classList.add("hidden");
    dom.transition.overlay.classList.remove("flex");
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
    state.playerIndex = 0; // Creator is always player 0
    dom.roomCodeDisplay.textContent = `Mã phòng: ${roomCode}. Đang chờ đối thủ...`;
    console.log(
      `[Client] Received 'roomCreated'. Room Code: ${roomCode}, Player Index: ${state.playerIndex}.`
    );
    updateUI(); // Cập nhật UI để kích hoạt nút ready nếu cần
  });

  socket.on("gameStart", (data) => {
    const self = data.players.find((p) => p.id === socket.id);
    if (self) {
      state.playerIndex = self.playerIndex;
    }
    state.roomCode = data.roomCode; // Quan trọng: Đảm bảo roomCode được set cho người chơi tham gia
    dom.lobby.style.display = "none";
    dom.game.style.display = "flex";
    state.phase = "PLACE";
    initGameBoards();
    updateUI();
    console.log("[Client] Received 'gameStart'. Transitioning to PLACE phase.");
    console.log(
      "[Client] Current client state after gameStart:",
      JSON.parse(JSON.stringify(state))
    );
  });

  socket.on("error", (message) => {
    console.error(`[Client] Received error from server: ${message}`);
    showTransition("Lỗi", message, "Đóng");
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
    if (type === "place") {
      container.addEventListener("mouseover", handleCellHover);
      container.addEventListener("mouseout", handleCellMouseOut);
      container.addEventListener("click", handleCellClick);
    } else if (type === "shoot") {
      container.addEventListener("click", handleCellClick);
    }
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
    if (state.phase !== "PLACE") return;
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
    if (state.phase !== "PLACE") return;
    if (state.planesPlaced < PLANES_PER_PLAYER) {
      updateInfo(`Bạn cần đặt đủ ${PLANES_PER_PLAYER} máy bay.`);
      console.log(
        `[Client] Ready button clicked but not enough planes placed (${state.planesPlaced}/${PLANES_PER_PLAYER}).`
      );
      return;
    }
    // --- FIX: Chỉ gửi planesPlaced nếu roomCode đã được thiết lập ---
    if (state.roomCode === null) {
      // Đảm bảo roomCode đã có giá trị
      updateInfo(
        "Lỗi: Mã phòng chưa được thiết lập. Vui lòng thử lại hoặc kết nối lại."
      );
      console.error("[Client] Cannot send planesPlaced: roomCode is null.");
      return;
    }
    // --- END FIX ---

    state.phase = "WAITING";
    socket.emit("planesPlaced", {
      roomCode: state.roomCode,
      placeBoard: state.placeBoard,
    });

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
    console.log(
      "[Client] Current client state after planesPlaced:",
      JSON.parse(JSON.stringify(state))
    );
  });

  dom.transition.button.addEventListener("click", () => {
    console.log("[Client] Transition button clicked. Hiding overlay.");
    dom.transition.overlay.classList.add("hidden");
    dom.transition.overlay.classList.remove("flex");
    if (state.phase === "GAMEOVER") {
      resetGame();
    }
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
        updateInfo("Không thể đặt máy bay ở đây!");
        console.log(
          `[Client] Cannot place plane at [${r}, ${c}]. Invalid position or occupied.`
        );
      }
    } else if (state.phase === "SHOOT" && type === "shoot") {
      if (!state.isMyTurn) {
        updateInfo("Không phải lượt của bạn!");
        console.log("[Client] Cannot shoot: Not your turn.");
        return;
      }
      if (state.roomCode === null) {
        // Kiểm tra lại roomCode
        updateInfo("Lỗi: Mã phòng không hợp lệ để bắn.");
        console.error("[Client] Cannot shoot: roomCode is null.");
        return;
      }

      if (state.shootBoard[r][c] !== null) {
        updateInfo("Ô này đã bị bắn rồi!");
        console.log(
          `[Client] Cell [${r}, ${c}] already shot (on my shootBoard). Cannot shoot again.`
        );
        return;
      }

      socket.emit("shoot", { roomCode: state.roomCode, row: r, col: c });
      console.log(`[Client] Emitted 'shoot' at [${r}, ${c}].`);
      state.isMyTurn = false; // Tối ưu: vô hiệu hóa ngay lập tức trên client
      updateUI();
    } else if (state.phase !== "SHOOT" && type === "shoot") {
      console.log(
        `[Client] Cannot shoot: Not in SHOOT phase (current phase: ${state.phase}).`
      );
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
    let timeLeft = Math.ceil(timeLimit / 1000);
    dom.placementTimerDisplay.classList.remove("hidden");
    dom.placementTimerDisplay.textContent = `Thời gian đặt: ${timeLeft}s`;

    console.log(
      `[Client] Received 'placementTimerStarted' with ${timeLeft} seconds.`
    );

    if (!placementCountdownInterval && state.phase === "PLACE") {
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
    } else {
      console.log(
        "[Client] Placement timer not started: Already running or not in PLACE phase."
      );
    }
  });

  socket.on("opponentReady", () => {
    updateInfo("Đối thủ của bạn đã đặt xong máy bay. Hãy nhanh lên!");
    console.log("[Client] Received 'opponentReady'.");
  });

  socket.on("shootingPhaseStart", (data) => {
    state.phase = "SHOOT";
    state.isMyTurn = state.playerIndex === data.currentTurnIndex;

    // 🔧 FIX: Đảm bảo lớp phủ chuyển tiếp bị ẩn ngay lập tức
    dom.transition.overlay.classList.add("hidden");
    dom.transition.overlay.classList.remove("flex");

    if (placementCountdownInterval) {
      // Clear any remaining client-side timer
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
    }
    dom.placementTimerDisplay.classList.add("hidden");

    updateInfo(
      state.isMyTurn ? "Đến lượt bạn bắn trước!" : "Chờ đối thủ bắn trước."
    );

    updateUI();
    console.log(
      `[Client] Received 'shootingPhaseStart'. Transitioned to SHOOT phase. Initial turn: ${data.currentTurnIndex}, My turn: ${state.isMyTurn}.`
    );
    console.log(
      "[Client] Current client state after shootingPhaseStart:",
      JSON.parse(JSON.stringify(state))
    );
  });

  socket.on("newTurn", (turnIndex) => {
    state.isMyTurn = state.playerIndex === turnIndex;
    updateUI();
    console.log(
      `[Client] Received 'newTurn'. My turn: ${state.isMyTurn} (Player Index: ${state.playerIndex}, Turn Index from server: ${turnIndex}).`
    );
    console.log(
      "[Client] Current client state after newTurn:",
      JSON.parse(JSON.stringify(state))
    );
  });

  socket.on("shotResult", ({ shooterIndex, row, col, result }) => {
    const isMyShot = shooterIndex === state.playerIndex;

    if (isMyShot) {
      state.shootBoard[row][col] = result;
      console.log(
        `[Client] My shot at [${row}, ${col}] resulted in: ${result}.`
      );
    } else {
      state.placeBoard[row][col] = result;
      console.log(
        `[Client] Opponent shot at [${row}, ${col}] resulted in: ${result}.`
      );
    }
    updateUI();
    console.log(`[Client] Processed shotResult. Boards updated.`);
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
      state.phase = "GAMEOVER";
    }
    if (placementCountdownInterval) {
      clearInterval(placementCountdownInterval);
      placementCountdownInterval = null;
      dom.placementTimerDisplay.classList.add("hidden");
    }
    updateUI();
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
    void dom.infoPanel.offsetWidth;
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
        cell.className = "grid-cell";
        cell.dataset.type = type;
        const val = boardData[r][c];

        if (type === "place") {
          if (val === "H") cell.classList.add("cell-head");
          else if (val === "B") cell.classList.add("cell-placed");
          else if (val === "D") cell.classList.add("cell-hit-head");
          else if (val === "I") cell.classList.add("cell-hit-body");
          else if (val === "M") cell.classList.add("cell-miss");
          else cell.classList.add("cell-empty");
        } else {
          if (val === "D") cell.classList.add("cell-hit-head");
          else if (val === "I") cell.classList.add("cell-hit-body");
          else if (val === "M") cell.classList.add("cell-miss");
          else cell.classList.add("cell-empty");
        }
      }
    }
  }

  function updateUI() {
    renderBoard(dom.myPlaceBoard, state.placeBoard, "place");
    renderBoard(dom.opponentShootBoard, state.shootBoard, "shoot");

    dom.controlsArea.style.display = state.phase === "PLACE" ? "flex" : "none";

    // --- FIX: Vô hiệu hóa nút Ready cho đến khi roomCode được thiết lập ---
    dom.readyButton.disabled = !(
      state.planesPlaced >= PLANES_PER_PLAYER && state.roomCode !== null
    );
    // Thay vì display = 'block' / 'none', dùng disabled để trực quan hơn
    // if (dom.readyButton.disabled) {
    //     dom.readyButton.style.opacity = 0.5; // Làm mờ khi bị vô hiệu hóa
    //     dom.readyButton.style.cursor = 'not-allowed';
    // } else {
    //     dom.readyButton.style.opacity = 1;
    //     dom.readyButton.style.cursor = 'pointer';
    // }
    // --- END FIX ---

    if (state.phase === "SHOOT" && state.isMyTurn) {
      dom.opponentShootBoard.style.cursor = "crosshair";
      dom.opponentShootBoard.style.pointerEvents = "auto";
      dom.opponentShootBoard.classList.remove("disabled-board");
    } else {
      dom.opponentShootBoard.style.cursor = "default";
      dom.opponentShootBoard.style.pointerEvents = "none";
      dom.opponentShootBoard.classList.add("disabled-board");
    }

    let infoMessage = "";
    switch (state.phase) {
      case "LOBBY":
        infoMessage = "Chờ người chơi hoặc tạo/tham gia phòng.";
        break;
      case "PLACE":
        infoMessage = `Hãy đặt máy bay ${state.planesPlaced}/${PLANES_PER_PLAYER}. Xoay và click để đặt.`;
        break;
      case "WAITING":
        infoMessage = "Đang chờ đối thủ đặt máy bay...";
        break;
      case "SHOOT":
        infoMessage = state.isMyTurn
          ? "Lượt của bạn! Hãy tấn công một ô trên bàn đối thủ."
          : "Lượt của đối thủ. Xin chờ...";
        break;
      case "GAMEOVER":
        infoMessage = "TRÒ CHƠI KẾT THÚC!";
        break;
      default:
        infoMessage = "";
    }
    updateInfo(infoMessage);

    console.log(
      `[Client] UI Updated. Phase: ${state.phase}, Is My Turn: ${state.isMyTurn}, Planes Placed: ${state.planesPlaced}, Room Code: ${state.roomCode}`
    );
  }

  // --- INITIALIZE GAME ---
  resetGame();
});
