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
const PLACEMENT_TIME_LIMIT = 30000;
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

// --- HELPER FUNCTIONS ---
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
  let attempts = 0;
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

// ========== NEW ROBUST CLEANUP FUNCTION ==========
/**
 * Dọn dẹp và xóa một phòng khỏi server state.
 * @param {string} roomCode Mã phòng cần dọn dẹp.
 */
function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (room) {
    // Hủy bất kỳ bộ đếm thời gian nào đang chạy để tránh lỗi
    if (room.placementTimer) {
      clearTimeout(room.placementTimer);
      room.placementTimer = null;
    }
    // Xóa phòng khỏi đối tượng rooms
    delete rooms[roomCode];
    console.log(
      `[Server] Đã dọn dẹp và xóa phòng: ${roomCode}. Số phòng hiện tại: ${
        Object.keys(rooms).length
      }`
    );
  }
}
// ===============================================

const startShootingPhase = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || room.state !== "placing") {
    return;
  }
  room.players.forEach((player) => {
    if (!player.ready || !player.placeBoard) {
      player.placeBoard = generateRandomPlaceBoard();
      player.ready = true;
      console.log(
        `[Server] Player ${player.playerIndex} (${player.id}) tự động đặt máy bay do hết giờ.`
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
      currentTurnIndex: 0,
      placementTimer: null,
    };
    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
    console.log(
      `[Server] Phòng ${roomCode} đã được tạo bởi ${
        socket.id
      }. Số phòng hiện tại: ${Object.keys(rooms).length}`
    );
  });

  socket.on("joinRoom", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit("error", "Phòng không tồn tại.");
    }
    if (room.players.length >= 2) {
      // Thêm log để gỡ lỗi
      console.log(
        `[Server] Lỗi: ${
          socket.id
        } cố gắng tham gia phòng ${roomCode} đã đầy. Người chơi hiện tại: ${room.players
          .map((p) => p.id)
          .join(", ")}`
      );
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
    io.to(roomCode).emit("gameStart", { roomCode: roomCode });
    io.to(roomCode).emit("placementTimerStarted", PLACEMENT_TIME_LIMIT);
    room.placementTimer = setTimeout(() => {
      startShootingPhase(roomCode);
    }, PLACEMENT_TIME_LIMIT);
  });

  socket.on("planesPlaced", ({ roomCode, placeBoard }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "placing") return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    const headCount = placeBoard.flat().filter((cell) => cell === "H").length;
    if (headCount !== PLANES_PER_PLAYER) {
      return socket.emit(
        "error",
        `Bạn phải đặt đúng ${PLANES_PER_PLAYER} máy bay.`
      );
    }
    player.placeBoard = placeBoard;
    player.ready = true;
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit("opponentReady");
    }
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      if (room.placementTimer) {
        clearTimeout(room.placementTimer);
        room.placementTimer = null;
      }
      startShootingPhase(roomCode);
    }
  });

  socket.on("shoot", ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "shooting") return;
    const shooter = room.players.find((p) => p.id === socket.id);
    if (!shooter || shooter.playerIndex !== room.currentTurnIndex) return;
    const targetPlayer = room.players.find((p) => p.id !== socket.id);
    if (!targetPlayer || !targetPlayer.placeBoard) return;
    const currentShotValue = targetPlayer.placeBoard[row][col];
    if (["D", "I", "M"].includes(currentShotValue)) return;
    let result = "M";
    if (currentShotValue === "H") result = "D";
    else if (currentShotValue === "B") result = "I";
    targetPlayer.placeBoard[row][col] = result;
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
        `[Server] TRÒ CHƠI KẾT THÚC. Thắng: ${shooter.playerIndex}. Dọn dẹp phòng ${roomCode}.`
      );
      // ========== USE ROBUST CLEANUP ==========
      cleanupRoom(roomCode);
      return;
    }
    room.currentTurnIndex = (room.currentTurnIndex + 1) % 2;
    io.to(roomCode).emit("newTurn", room.currentTurnIndex);
  });

  // ========== REVISED DISCONNECT HANDLER ==========
  socket.on("disconnect", () => {
    console.log(`[Server] Người dùng đã ngắt kết nối: ${socket.id}`);
    // Tìm phòng mà người chơi này đang ở
    const roomCode = Object.keys(rooms).find((rc) =>
      rooms[rc].players.some((p) => p.id === socket.id)
    );

    if (roomCode) {
      console.log(`[Server] Phòng ${roomCode}: Người chơi ${socket.id} thoát.`);
      // Thông báo cho người chơi còn lại
      io.to(roomCode).emit("opponentLeft");
      // Dọn dẹp phòng bằng hàm chuyên dụng
      cleanupRoom(roomCode);
    }
  });
  // ===============================================
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Máy chủ đang lắng nghe tại cổng ${PORT}`);
});
