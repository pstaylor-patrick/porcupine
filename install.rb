#!/usr/bin/env ruby
# frozen_string_literal: true

# Porcupine installer. Idempotent; safe to re-run after a git pull.
#
#   ruby install.rb            check prereqs, npm ci, build, pinned pi, link CLIs
#   ruby install.rb --no-pi    skip the pinned pi install
#
# Everything is per user: pi and the CLI links go under ~/.local, never
# system paths, and no global npm install touches the host prefix.

require "fileutils"
require "open3"

ROOT = __dir__
BIN_DIR = File.join(Dir.home, ".local", "bin")
ENV_FILE = ENV.fetch("PORCUPINE_ENV_FILE", File.join(Dir.home, ".config/porcupine/.env"))
REQUIRED_SECRETS = %w[PORCUPINE_RPC_PASSWORD PORCUPINE_COOKIE_SECRET VERCEL_AI_GATEWAY_API_KEY].freeze
LINKS = {
  "porcupine" => "hub/dist/cli/main.js",
  "porcupine-hub" => "hub/dist/server/main.js"
}.freeze

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
    warn_line "missing; create it with #{REQUIRED_SECRETS.join(', ')}"
    return
  end
  keys = File.readlines(ENV_FILE).filter_map { |l| l[/\A\s*([A-Z0-9_]+)=\S/, 1] }
  REQUIRED_SECRETS.each do |k|
    keys.include?(k) ? puts("    #{k}: set") : warn_line("#{k} is not set")
  end
end

check_prereqs
build
install_pi unless ARGV.include?("--no-pi")
link_clis
check_secrets

puts <<~NEXT

  Done. Start the hub (once) and a named session:
    tmux new-session -d -s porcupine-hub 'PORCUPINE_HUB_ADDR=172.17.0.1:8787 porcupine-hub'
    tmux new-session -s myrepo -c ~/code/org/myrepo 'porcupine --name myrepo'
NEXT
