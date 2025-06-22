const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const PLACEMENT_TIME_LIMIT = 60000; // Tăng lên 60 giây cho thoải mái
const ROWS = 10;
const COLS = 10;
const PLANES_PER_PLAYER = 3;
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
const DIRECTIONS = ["down", "left", "up", "right"];

// --- HELPER FUNCTIONS FOR RANDOM BOARD GENERATION ---
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

function placePlaneOnBoard(board, headRow, headCol, shape) {
  board[headRow + shape[0][1]][headCol + shape[0][0]] = "H";
  for (let i = 1; i < shape.length; i++) {
    const [dx, dy] = shape[i];
    board[headRow + dy][headCol + dx] = "B";
  }
}

function generateRandomPlaceBoard() {
  let board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  let planesPlaced = 0;
  let attempts = 0; // Prevent infinite loops
  while (planesPlaced < PLANES_PER_PLAYER && attempts < 1000) {
    const randomRow = Math.floor(Math.random() * ROWS);
    const randomCol = Math.floor(Math.random() * COLS);
    const randomDirection =
      DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const shape = getRotatedShape(randomDirection);

    if (canPlacePlane(board, randomRow, randomCol, shape)) {
      placePlaneOnBoard(board, randomRow, randomCol, shape);
      planesPlaced++;
    }
    attempts++;
  }
  return board;
}
// --- END HELPER FUNCTIONS ---

const startShootingPhase = (roomCode) => {
  const room = rooms[roomCode];
  console.log(
    `[Server] Attempting to start shooting phase for room ${roomCode}`
  );

  if (!room || room.state !== "placing") {
    console.log(
      `[Server] Aborting startShootingPhase: Room ${roomCode} not in 'placing' state or does not exist. Current state: ${
        room ? room.state : "N/A"
      }`
    );
    return;
  }

  // --- CẢI TIẾN: Hủy timer một cách an toàn ---
  if (room.placementTimer) {
    clearTimeout(room.placementTimer);
    room.placementTimer = null;
    console.log(`[Server] Cleared placement timer for room ${roomCode}.`);
  }

  // --- LOGIC CŨ VẪN RẤT TỐT: Đảm bảo người chơi có bàn cờ ---
  room.players.forEach((player) => {
    if (!player.ready || !player.placeBoard) {
      player.placeBoard = generateRandomPlaceBoard();
      player.ready = true;
      console.log(
        `[Server] Player ${player.playerIndex} (${player.id}) timed out. Generated a random board.`
      );
      // Gửi lại bàn cờ được tạo ngẫu nhiên cho client đó để UI được đồng bộ
      io.to(player.id).emit("shootingPhaseStart", {
        timedOutPlayerId: player.id,
        timedOutPlayerBoard: player.placeBoard,
      });
    }
  });

  room.state = "shooting";

  // Gửi cho những người chơi không bị timeout
  const nonTimedOutPlayers = room.players.filter((p) => !p.timedOut);
  nonTimedOutPlayers.forEach((p) => {
    // Nếu client chưa nhận event từ việc timeout ở trên, gửi event bình thường
    if (!io.sockets.sockets.get(p.id).emittedShootingPhase) {
      io.to(p.id).emit("shootingPhaseStart");
    }
  });

  // Chọn lượt đi ngẫu nhiên
  room.currentTurnIndex = Math.floor(Math.random() * 2);
  io.to(roomCode).emit("newTurn", room.currentTurnIndex);

  console.log(
    `[Server] Room ${roomCode}: SHOOTING PHASE STARTED. Turn starts with player ${room.currentTurnIndex}.`
  );
};

io.on("connection", (socket) => {
  console.log(`[Server] User connected: ${socket.id}`);

  socket.on("createRoom", () => {
    let roomCode;
    do {
      roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (rooms[roomCode]);

    rooms[roomCode] = {
      players: [
        { id: socket.id, playerIndex: 0, ready: false, placeBoard: null },
      ],
      state: "waiting",
      currentTurnIndex: 0, // Sẽ được random lại khi bắt đầu bắn
      placementTimer: null,
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
    console.log(`[Server] Room ${roomCode} created by ${socket.id}`);
  });

  socket.on("joinRoom", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit("error", "Phòng không tồn tại.");
    }
    if (room.players.length >= 2) {
      return socket.emit("error", "Phòng đã đầy.");
    }

    socket.join(roomCode);
    room.players.push({
      id: socket.id,
      playerIndex: 1,
      ready: false,
      placeBoard: null,
    });
    room.state = "placing";
    console.log(
      `[Server] ${socket.id} joined room ${roomCode}. State: ${room.state}`
    );

    const playerInfo = room.players.map((p) => ({
      id: p.id,
      playerIndex: p.playerIndex,
    }));

    // --- SỬA LỖI: Gửi thông tin game cho CẢ HAI client trong phòng ---
    io.to(roomCode).emit("gameStart", {
      players: playerInfo,
      roomCode: roomCode,
    });
    console.log(
      `[Server] Room ${roomCode}: Emitted 'gameStart' to all players.`
    );

    io.to(roomCode).emit("placementTimerStarted", PLACEMENT_TIME_LIMIT);
    console.log(
      `[Server] Room ${roomCode}: Placement timer started (${
        PLACEMENT_TIME_LIMIT / 1000
      }s).`
    );

    room.placementTimer = setTimeout(() => {
      console.log(`[Server] Room ${roomCode}: Placement time is up.`);
      startShootingPhase(roomCode);
    }, PLACEMENT_TIME_LIMIT);
  });

  socket.on("planesPlaced", ({ roomCode, placeBoard }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "placing") {
      return console.log(
        `[Server] 'planesPlaced' ignored. Room ${roomCode} not in 'placing' state.`
      );
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    // Validate board
    const headCount = placeBoard.flat().filter((cell) => cell === "H").length;
    if (headCount !== PLANES_PER_PLAYER) {
      return socket.emit(
        "error",
        `Bạn phải đặt đúng ${PLANES_PER_PLAYER} máy bay.`
      );
    }

    player.placeBoard = placeBoard;
    player.ready = true;
    console.log(
      `[Server] Room ${roomCode}: Player ${player.playerIndex} is ready.`
    );

    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit("opponentReady");
    }

    // --- CẢI TIẾN: Hủy timer khi cả hai đã sẵn sàng ---
    if (room.players.every((p) => p.ready)) {
      console.log(
        `[Server] Room ${roomCode}: All players are ready. Starting shooting phase.`
      );
      startShootingPhase(roomCode);
    }
  });

  socket.on("shoot", ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "shooting") return;

    const shooter = room.players.find((p) => p.id === socket.id);
    if (!shooter || shooter.playerIndex !== room.currentTurnIndex) {
      console.log(`[Server] Invalid turn shoot attempt by ${socket.id}`);
      return;
    }

    const targetPlayer = room.players.find((p) => p.id !== socket.id);
    if (!targetPlayer || !targetPlayer.placeBoard) {
      console.error(
        `[Server] CRITICAL ERROR: Target player or their board is missing in room ${roomCode}`
      );
      return socket.emit("error", "Lỗi server: không tìm thấy đối thủ.");
    }

    const currentShotValue = targetPlayer.placeBoard[row][col];
    if (["D", "I", "M"].includes(currentShotValue)) {
      console.log(
        `[Server] Player ${socket.id} shot an already targeted cell.`
      );
      return; // Ô này đã được bắn, không làm gì cả.
    }

    let result = "M"; // Miss
    if (currentShotValue === "H") {
      result = "D"; // Destroyed
    } else if (currentShotValue === "B") {
      result = "I"; // Hit Body
    }

    targetPlayer.placeBoard[row][col] = result;
    console.log(
      `[Server] Shot at [${row}, ${col}] by Player ${shooter.playerIndex} resulted in ${result}.`
    );

    io.to(roomCode).emit("shotResult", {
      shooterIndex: shooter.playerIndex,
      row,
      col,
      result,
    });

    // Check for game over
    if (result === "D") {
      const headsLeft = targetPlayer.placeBoard
        .flat()
        .filter((cell) => cell === "H").length;
      if (headsLeft === 0) {
        room.state = "finished";
        io.to(roomCode).emit("gameOver", shooter.playerIndex);
        console.log(
          `[Server] Room ${roomCode}: GAME OVER. Winner is Player ${shooter.playerIndex}`
        );
        delete rooms[roomCode];
        return;
      }
    }

    // Switch turns
    room.currentTurnIndex = (room.currentTurnIndex + 1) % 2;
    io.to(roomCode).emit("newTurn", room.currentTurnIndex);
    console.log(
      `[Server] Room ${roomCode}: New turn. Player ${room.currentTurnIndex}'s turn.`
    );
  });

  socket.on("disconnect", () => {
    console.log(`[Server] User disconnected: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room.players.find((p) => p.id === socket.id);

      if (player) {
        console.log(`[Server] Player ${socket.id} left room ${roomCode}.`);

        // --- CẢI TIẾN: Dọn dẹp timer và phòng ---
        if (room.placementTimer) {
          clearTimeout(room.placementTimer);
          room.placementTimer = null;
          console.log(
            `[Server] Cleared placement timer for room ${roomCode} due to disconnect.`
          );
        }

        // Thông báo cho người chơi còn lại và xóa phòng
        socket.to(roomCode).emit("opponentLeft");
        delete rooms[roomCode];
        console.log(`[Server] Deleted room ${roomCode}.`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
