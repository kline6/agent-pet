#!/usr/bin/env node
/**
 * Agent Pet - Hook 安装器
 * 自动检测 Codex/Claude 会话目录并写入 Agent Pet 配置
 *
 * Usage:
 *   node scripts/setup-hooks.js          # 安装（自动检测并配置路径）
 *   node scripts/setup-hooks.js --uninstall  # 卸载（清除自定义路径，恢复默认）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 常量 ──────────────────────────────────────────────────────

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const SETTINGS_DIR = path.join(APPDATA, 'agent-pet');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

const SOURCES = {
  codex: {
    label: 'Codex CLI',
    defaultPath: path.join(os.homedir(), '.codex', 'sessions'),
    checkPaths: [
      path.join(os.homedir(), '.codex', 'sessions'),
      path.join(os.homedir(), '.codex'),
    ],
    filePattern: /\.jsonl$/i,
  },
  claude: {
    label: 'Claude Code',
    defaultPath: path.join(os.homedir(), '.claude', 'projects'),
    checkPaths: [
      path.join(os.homedir(), '.claude', 'projects'),
      path.join(os.homedir(), '.claude'),
    ],
    filePattern: /\.jsonl$/i,
  },
};

// ── 工具函数 ──────────────────────────────────────────────────

function log(emoji, msg) {
  console.log(`  ${emoji}  ${msg}`);
}

function findLatestSessionFile(dir, pattern) {
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtime: stat.mtime });
      } else if (entry.isDirectory()) {
        // Recurse one level (e.g. .claude/projects/<project>/)
        const subDir = path.join(dir, entry.name);
        const subFiles = findLatestSessionFile(subDir, pattern);
        if (subFiles) files.push(subFiles);
      }
    }
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0];
  } catch {
    return null;
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch (e) {
    log('⚠️', `无法读取现有配置: ${e.message}`);
  }
  return {};
}

function saveSettings(settings) {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// ── 安装 ──────────────────────────────────────────────────────

function install() {
  console.log('\n🐾 Agent Pet Hook 安装器\n');
  console.log('正在检测 AI Agent 会话目录...\n');

  const settings = loadSettings();
  if (!settings.liveSourcePaths) settings.liveSourcePaths = {};

  let configured = 0;

  for (const [key, source] of Object.entries(SOURCES)) {
    log('🔍', `检测 ${source.label}...`);

    let found = false;
    for (const checkPath of source.checkPaths) {
      if (fs.existsSync(checkPath)) {
        log('✅', `找到目录: ${checkPath}`);
        found = true;

        // Find latest session file
        const latest = findLatestSessionFile(checkPath, source.filePattern);
        if (latest) {
          const age = Math.round((Date.now() - latest.mtime.getTime()) / 60000);
          log('📄', `最新会话文件: ${path.basename(latest.path)} (${age} 分钟前)`);
        } else {
          log('📄', '暂无会话文件（启动 Agent 后会自动生成）');
        }

        // Write path to settings
        settings.liveSourcePaths[key] = source.defaultPath;
        configured++;
        break;
      }
    }

    if (!found) {
      log('⚠️', `未找到 ${source.label} 目录`);
      log('💡', `请先安装 ${source.label}，或手动配置路径`);
      // Still write default path so the app knows where to look
      settings.liveSourcePaths[key] = source.defaultPath;
    }

    console.log('');
  }

  saveSettings(settings);

  log('💾', `配置已写入: ${SETTINGS_FILE}`);
  log('🎉', `完成！已配置 ${configured} 个 Agent 的会话监控路径`);
  console.log('\n启动 Agent Pet 后，宠物将自动感知 Agent 活动状态。\n');
}

// ── 卸载 ──────────────────────────────────────────────────────

function uninstall() {
  console.log('\n🐾 Agent Pet Hook 卸载器\n');

  const settings = loadSettings();
  if (settings.liveSourcePaths) {
    delete settings.liveSourcePaths;
    saveSettings(settings);
    log('🗑️', '已清除自定义路径配置（恢复为默认值）');
  } else {
    log('ℹ️', '没有自定义路径配置，无需清除');
  }

  log('💾', `配置已更新: ${SETTINGS_FILE}`);
  console.log('');
}

// ── 主入口 ────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--uninstall') || args.includes('-u')) {
  uninstall();
} else {
  install();
}
