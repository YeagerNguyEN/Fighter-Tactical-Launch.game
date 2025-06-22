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
const PLACEMENT_TIME_LIMIT = 30000; // 30 giây
const ROWS = 10;
const COLS = 10;
const PLANES_PER_PLAYER = 3;
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
  if (!room || room.state !== "placing") {
    console.log(
      `[Server] startShootingPhase: Room ${roomCode} is not in 'placing' state or does not exist. Aborting.`
    );
    return;
  }

  // Nếu một người chơi chưa sẵn sàng (do hết giờ), tạo bảng ngẫu nhiên cho họ
  room.players.forEach((player) => {
    if (!player.ready || !player.placeBoard) {
      player.placeBoard = generateRandomPlaceBoard();
      player.ready = true;
      console.log(
        `[Server] Player ${player.playerIndex} (${player.id}) did not submit placeBoard in time. Generated random board for them.`
      );
    }
  });

  room.state = "shooting";
  io.to(roomCode).emit("shootingPhaseStart");
  io.to(roomCode).emit("newTurn", room.currentTurnIndex);

  console.log(
    `[Server] Phòng ${roomCode}: BẮT ĐẦU BẮN. Lượt của người chơi ${room.currentTurnIndex}.`
  );
};

io.on("connection", (socket) => {
  console.log(`[Server] Người dùng đã kết nối: ${socket.id}`);

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
      currentTurnIndex: 0, // Player 0 starts
      placementTimer: null,
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
    console.log(`[Server] Phòng ${roomCode} đã được tạo bởi ${socket.id}`);
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
      `[Server] ${socket.id} đã tham gia phòng ${roomCode}. Trạng thái phòng: ${room.state}`
    );

    // Gửi sự kiện gameStart tới tất cả người chơi trong phòng
    io.to(roomCode).emit("gameStart", {
      roomCode: roomCode,
    });
    console.log(
      `[Server] Phòng ${roomCode}: Trò chơi bắt đầu (giai đoạn đặt).`
    );

    io.to(roomCode).emit("placementTimerStarted", PLACEMENT_TIME_LIMIT);
    console.log(
      `[Server] Phòng ${roomCode}: Bắt đầu đếm ngược đặt máy bay (${
        PLACEMENT_TIME_LIMIT / 1000
      }s).`
    );
    room.placementTimer = setTimeout(() => {
      console.log(`[Server] Phòng ${roomCode}: Hết giờ đặt máy bay.`);
      startShootingPhase(roomCode);
    }, PLACEMENT_TIME_LIMIT);
  });

  // ========== FIXED CODE BLOCK ==========
  socket.on("planesPlaced", ({ roomCode, placeBoard }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "placing") {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) {
      return;
    }

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
      `[Server] Phòng ${roomCode}: Người chơi ${player.playerIndex} đã sẵn sàng.`
    );

    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit("opponentReady");
    }

    // FIX: Kiểm tra nếu cả hai người chơi đã sẵn sàng
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      console.log(
        `[Server] Phòng ${roomCode}: CẢ HAI người chơi đã sẵn sàng. Bắt đầu giai đoạn bắn.`
      );
      // Hủy bộ đếm thời gian ngay lập tức
      if (room.placementTimer) {
        clearTimeout(room.placementTimer);
        room.placementTimer = null;
        console.log(`[Server] Đã hủy bộ đếm thời gian cho phòng ${roomCode}.`);
      }
      // Bắt đầu màn bắn
      startShootingPhase(roomCode);
    }
  });
  // =====================================

  socket.on("shoot", ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "shooting") {
      return;
    }

    const shooter = room.players.find((p) => p.id === socket.id);
    if (!shooter || shooter.playerIndex !== room.currentTurnIndex) {
      return;
    }

    const targetPlayer = room.players.find((p) => p.id !== socket.id);
    if (!targetPlayer || !targetPlayer.placeBoard) {
      return socket.emit("error", "Lỗi: Không tìm thấy bảng của đối thủ.");
    }

    const currentShotValue = targetPlayer.placeBoard[row][col];
    if (["D", "I", "M"].includes(currentShotValue)) {
      return; // Ô này đã được bắn
    }

    let result = "M"; // Miss (Trượt)
    if (currentShotValue === "H") {
      result = "D"; // Destroyed (Phá hủy đầu)
    } else if (currentShotValue === "B") {
      result = "I"; // Hit Body (Trúng thân)
    }

    targetPlayer.placeBoard[row][col] = result;
    console.log(
      `[Server] Shot from ${shooter.playerIndex} at [${row}, ${col}]: ${result}.`
    );

    io.to(roomCode).emit("shotResult", {
      shooterIndex: shooter.playerIndex,
      row,
      col,
      result,
    });

    const headsLeft = targetPlayer.placeBoard
      .flat()
      .filter((cell) => cell === "H").length;

    if (headsLeft === 0) {
      room.state = "finished";
      io.to(roomCode).emit("gameOver", shooter.playerIndex);
      console.log(
        `[Server] Phòng ${roomCode}: TRÒ CHƠI KẾT THÚC. Thắng: ${shooter.playerIndex}`
      );
      delete rooms[roomCode];
      return;
    }

    room.currentTurnIndex = (room.currentTurnIndex + 1) % 2;
    io.to(roomCode).emit("newTurn", room.currentTurnIndex);
    console.log(
      `[Server] Phòng ${roomCode}: Chuyển lượt. Lượt tiếp theo: ${room.currentTurnIndex}.`
    );
  });

  socket.on("disconnect", () => {
    console.log(`[Server] Người dùng đã ngắt kết nối: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const playerIndex = room.players.findIndex((p) => p.id === socket.id);

      if (playerIndex !== -1) {
        console.log(
          `[Server] Phòng ${roomCode}: Người chơi ${socket.id} thoát.`
        );
        // Hủy timer nếu có
        if (room.placementTimer) {
          clearTimeout(room.placementTimer);
        }
        // Thông báo cho người chơi còn lại và xóa phòng
        io.to(roomCode).emit("opponentLeft");
        delete rooms[roomCode];
        console.log(`[Server] Đã xóa phòng ${roomCode}.`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Máy chủ đang lắng nghe tại cổng ${PORT}`);
});
