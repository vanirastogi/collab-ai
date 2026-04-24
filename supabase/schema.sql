CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT 'Untitled Room',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  language      TEXT DEFAULT 'javascript',
  code          TEXT DEFAULT '',
  whiteboard    JSONB DEFAULT '{}',
  member_count  INT DEFAULT 0
);

CREATE TABLE room_members (
  room_id    TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  user_name  TEXT,
  joined_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX idx_rooms_created_by ON rooms(created_by);
CREATE INDEX idx_room_members_user ON room_members(user_id);

CREATE TABLE dsa_problems (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  difficulty  TEXT NOT NULL CHECK (difficulty IN ('Easy','Medium','Hard')),
  topic       TEXT NOT NULL,
  xp          INT NOT NULL
);

CREATE TABLE dsa_solves (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  problem_id  INT REFERENCES dsa_problems(id),
  solved_at   TIMESTAMPTZ DEFAULT now(),
  source      TEXT DEFAULT 'manual',
  room_id     TEXT,
  UNIQUE(user_id, problem_id)
);

CREATE TABLE user_profiles (
  user_id      TEXT PRIMARY KEY,
  user_name    TEXT,
  lc_username  TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now()
);

INSERT INTO dsa_problems (slug, title, difficulty, topic, xp) VALUES
('two-sum', 'Two Sum', 'Easy', 'Arrays', 10),
('valid-parentheses', 'Valid Parentheses', 'Easy', 'Stack', 10),
('merge-two-sorted-lists', 'Merge Two Sorted Lists', 'Easy', 'Linked List', 10),
('best-time-to-buy-and-sell-stock', 'Best Time to Buy and Sell Stock', 'Easy', 'Arrays', 10),
('climbing-stairs', 'Climbing Stairs', 'Easy', 'DP', 10),
('binary-search', 'Binary Search', 'Easy', 'Binary Search', 10),
('invert-binary-tree', 'Invert Binary Tree', 'Easy', 'Trees', 10),
('majority-element', 'Majority Element', 'Easy', 'Arrays', 10),
('linked-list-cycle', 'Linked List Cycle', 'Easy', 'Linked List', 10),
('maximum-depth-of-binary-tree', 'Maximum Depth of Binary Tree', 'Easy', 'Trees', 10),
('3sum', '3Sum', 'Medium', 'Two Pointers', 25),
('container-with-most-water', 'Container With Most Water', 'Medium', 'Two Pointers', 25),
('longest-substring-without-repeating-characters', 'Longest Substring Without Repeating Characters', 'Medium', 'Sliding Window', 25),
('product-of-array-except-self', 'Product of Array Except Self', 'Medium', 'Arrays', 25),
('binary-tree-level-order-traversal', 'Binary Tree Level Order Traversal', 'Medium', 'BFS', 25),
('number-of-islands', 'Number of Islands', 'Medium', 'Graphs', 25),
('coin-change', 'Coin Change', 'Medium', 'DP', 25),
('lru-cache', 'LRU Cache', 'Medium', 'Design', 25),
('word-search', 'Word Search', 'Medium', 'Backtracking', 25),
('subsets', 'Subsets', 'Medium', 'Backtracking', 25),
('trapping-rain-water', 'Trapping Rain Water', 'Hard', 'Two Pointers', 50),
('median-of-two-sorted-arrays', 'Median of Two Sorted Arrays', 'Hard', 'Binary Search', 50),
('merge-k-sorted-lists', 'Merge K Sorted Lists', 'Hard', 'Heap', 50),
('word-ladder', 'Word Ladder', 'Hard', 'BFS', 50),
('serialize-and-deserialize-binary-tree', 'Serialize and Deserialize Binary Tree', 'Hard', 'Trees', 50),
('longest-valid-parentheses', 'Longest Valid Parentheses', 'Hard', 'Stack', 50),
('regular-expression-matching', 'Regular Expression Matching', 'Hard', 'DP', 50),
('n-queens', 'N-Queens', 'Hard', 'Backtracking', 50),
('largest-rectangle-in-histogram', 'Largest Rectangle in Histogram', 'Hard', 'Stack', 50),
('alien-dictionary', 'Alien Dictionary', 'Hard', 'Topological Sort', 50);
