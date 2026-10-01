#!/usr/bin/env ruby
# frozen_string_literal: true

# Porcupine installer. Idempotent; safe to re-run after a git pull.
#
#   ruby install.rb            check prereqs, npm ci, build, pinned pi, link CLIs
#   ruby install.rb --no-pi    skip the pinned pi install
#   ruby install.rb --whisper  (re)build whisper.cpp and fetch the base model
#
# Everything is per user: pi and the CLI links go under ~/.local, never
# system paths, and no global npm install touches the host prefix.

require "fileutils"
require "open3"

ROOT = __dir__
BIN_DIR = File.join(Dir.home, ".local", "bin")
ENV_FILE = ENV.fetch("PORCUPINE_ENV_FILE") { File.join(ENV.fetch("XDG_CONFIG_HOME", File.join(Dir.home, ".config")), "porcupine", ".env") }
REQUIRED_KEYS = %w[PORCUPINE_ORIGIN PORCUPINE_RPC_PASSWORD PORCUPINE_COOKIE_SECRET].freeze
PROVIDER_KEYS = %w[OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY].freeze
LINKS = {
  "porcupine" => "hub/dist/cli/main.js",
  "porcupine-hub" => "hub/dist/server/main.js"
}.freeze
WHISPER_TAG = "v1.9.4"
WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp"
WHISPER_SRC = File.join(Dir.home, ".local", "src", "whisper.cpp")
WHISPER_BIN = File.join(BIN_DIR, "whisper-cli")
WHISPER_MODEL_DIR = File.join(ENV.fetch("XDG_DATA_HOME", File.join(Dir.home, ".local", "share")), "porcupine", "whisper")
WHISPER_MODEL = File.join(WHISPER_MODEL_DIR, "ggml-base.bin")

def step(msg) = puts("==> #{msg}")
def warn_line(msg) = puts("    warning: #{msg}")

def run!(*cmd)
  system(*cmd, chdir: ROOT) || abort("failed: #{cmd.join(' ')}")
end

def check_prereqs
  step "checking prerequisites"
  out, status = Open3.capture2("node", "--version")
  abort "node not found; install Node 22+ per user" unless status.success?
  major = out[/v(\d+)/, 1].to_i
  abort "node #{out.strip} is too old; need 22+" if major < 22
  puts "    node #{out.strip}"
  warn_line "tmux not found; sessions are meant to run in tmux" unless system("command -v tmux >/dev/null")
end

def build
  step "installing dependencies and building"
  run! "npm", "ci"
  run! "npm", "run", "build"
end

def install_pi
  step "installing pinned pi"
  run! File.join(ROOT, "scripts/install-pi.sh")
end

def link_clis
  step "linking CLIs into #{BIN_DIR}"
  FileUtils.mkdir_p(BIN_DIR)
  LINKS.each do |name, rel|
    target = File.join(ROOT, rel)
    File.chmod(0o755, target)
    FileUtils.ln_sf(target, File.join(BIN_DIR, name))
    puts "    #{name} -> #{target}"
  end
  warn_line "#{BIN_DIR} is not on PATH" unless ENV.fetch("PATH", "").split(":").include?(BIN_DIR)
end

# Reports which keys are present; never prints values.
def check_secrets
  step "checking secrets in #{ENV_FILE}"
  unless File.exist?(ENV_FILE)
    warn_line "missing; copy .env.example there and fill in #{REQUIRED_KEYS.join(', ')}"
    return
  end
  keys = File.readlines(ENV_FILE).filter_map { |l| l[/\A\s*([A-Z0-9_]+)=\S/, 1] }
  REQUIRED_KEYS.each do |k|
    keys.include?(k) ? puts("    #{k}: set") : warn_line("#{k} is not set")
  end
  providers = PROVIDER_KEYS.select { |k| keys.include?(k) }
  puts("    provider keys set: #{providers.empty? ? 'none' : providers.join(', ')}")
  warn_line "OPENROUTER_API_KEY is not set; it serves every model not routed direct" unless keys.include?("OPENROUTER_API_KEY")
end

def enable_hooks
  return unless File.directory?(File.join(ROOT, ".git"))

  step "enabling git hooks (scripts/hooks)"
  run! "git", "config", "core.hooksPath", "scripts/hooks"
  warn_line "gitleaks not found; the pre-commit hook will use Docker or skip" unless system("command -v gitleaks >/dev/null")
end

def have?(cmd) = system("command -v #{cmd} >/dev/null 2>&1")

# cmake is often absent; pipx installs it per user into ~/.local/bin.
def ensure_cmake
  return true if have?("cmake") || File.executable?(File.join(BIN_DIR, "cmake"))
  return false unless have?("pipx")

  puts "    installing cmake per user with pipx"
  system("pipx", "install", "cmake", out: File::NULL) && File.executable?(File.join(BIN_DIR, "cmake"))
end

def want_whisper?
  return true if ARGV.include?("--whisper")
  return false if File.executable?(WHISPER_BIN) && File.exist?(WHISPER_MODEL)
  return false unless $stdin.tty?

  print "    whisper.cpp is not installed (needed for audio and video attachments). Install it? [y/N] "
  $stdin.gets.to_s.strip.downcase.start_with?("y")
end

def build_whisper
  missing = %w[git].reject { |c| have?(c) }
  missing << "c++" unless have?("c++") || have?("g++") || have?("clang++")
  missing << "cmake" unless ensure_cmake
  unless missing.empty?
    warn_line "cannot build whisper.cpp; missing #{missing.join(', ')} (apt: build-essential cmake)"
    return
  end
  env = { "PATH" => "#{BIN_DIR}:#{ENV.fetch('PATH', '')}" }
  unless File.directory?(File.join(WHISPER_SRC, ".git"))
    FileUtils.mkdir_p(File.dirname(WHISPER_SRC))
    return warn_line("git clone failed") unless system("git", "clone", "-q", WHISPER_REPO, WHISPER_SRC)
  end
  ok = system("git", "-C", WHISPER_SRC, "fetch", "-q", "--tags", "origin") &&
       system("git", "-C", WHISPER_SRC, "-c", "advice.detachedHead=false", "checkout", "-q", WHISPER_TAG) &&
       system(env, "cmake", "-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF",
              "-DBUILD_SHARED_LIBS=OFF", chdir: WHISPER_SRC, out: File::NULL) &&
       system(env, "cmake", "--build", "build", "-j", "--config", "Release", "--target", "whisper-cli",
              chdir: WHISPER_SRC, out: File::NULL)
  return warn_line("whisper.cpp build failed") unless ok

  FileUtils.mkdir_p(BIN_DIR)
  FileUtils.install(File.join(WHISPER_SRC, "build", "bin", "whisper-cli"), WHISPER_BIN, mode: 0o755)
  puts "    whisper-cli #{WHISPER_TAG} -> #{WHISPER_BIN}"
end

def fetch_whisper_model
  return if File.exist?(WHISPER_MODEL)
  return warn_line("whisper.cpp source missing; cannot fetch the model") unless File.directory?(WHISPER_SRC)

  FileUtils.mkdir_p(WHISPER_MODEL_DIR, mode: 0o700)
  ok = system("sh", "./models/download-ggml-model.sh", "base", chdir: WHISPER_SRC, out: File::NULL)
  src = File.join(WHISPER_SRC, "models", "ggml-base.bin")
  return warn_line("model download failed") unless ok && File.exist?(src)

  FileUtils.mv(src, WHISPER_MODEL)
  puts "    model -> #{WHISPER_MODEL}"
end

def install_whisper
  return unless want_whisper?

  step "installing whisper.cpp #{WHISPER_TAG} under ~/.local"
  build_whisper if ARGV.include?("--whisper") || !File.executable?(WHISPER_BIN)
  fetch_whisper_model
end

def whisper_status
  if File.executable?(WHISPER_BIN) && File.exist?(WHISPER_MODEL)
    puts "whisper: ok (#{WHISPER_MODEL})"
  else
    puts "whisper: not installed; audio and video attachments will fail until you run ruby install.rb --whisper"
  end
end

check_prereqs
enable_hooks
build
install_pi unless ARGV.include?("--no-pi")
link_clis
install_whisper
check_secrets

puts <<~NEXT

  Done. Start the hub (once) and a named session:
    tmux new-session -d -s porcupine-hub porcupine-hub
    tmux new-session -s myrepo -c ~/code/myrepo 'porcupine --name myrepo'
NEXT
whisper_status
