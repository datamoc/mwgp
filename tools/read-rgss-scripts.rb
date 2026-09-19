# Decode the binary container used by RPG Maker XP/Essentials.
# Translation is deliberately done by the JavaScript Ruby2JS self-host tool;
# this helper only preserves Ruby's Marshal and Zlib byte semantics.
require 'base64'
require 'json'
require 'zlib'

path = ARGV.fetch(0)
entries = Marshal.load(File.binread(path))
entries = entries.flat_map do |entry|
  # Scripts.rxdata is [[id, name, zlib_bytes], ...]. PluginScripts.rxdata
  # groups [filename, zlib_bytes] pairs under [plugin_name, metadata, scripts].
  if entry.is_a?(Array) && entry.length >= 3 && entry[2].is_a?(Array)
    entry[2].each_with_index.map { |script, index| [index, script[0], script[1]] }
  else
    [entry]
  end
end
entries.each do |entry|
  id, name, compressed = entry
  source = Zlib::Inflate.inflate(compressed)
  puts JSON.generate(id: id, name: name.to_s, source: Base64.strict_encode64(source))
end
