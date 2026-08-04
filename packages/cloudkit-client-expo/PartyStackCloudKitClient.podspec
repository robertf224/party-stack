require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name           = "PartyStackCloudKitClient"
  s.version        = package["version"]
  s.summary        = "CloudKit client for Party Stack"
  s.description    = "Thin Expo Modules bridge to Apple's CloudKit APIs."
  s.license        = "MIT"
  s.author         = "Party Stack"
  s.homepage       = "https://github.com/bobbyfidz/party-stack"
  s.platforms      = { :ios => "15.1" }
  s.source         = { :git => "https://github.com/bobbyfidz/party-stack.git" }
  s.static_framework = true

  s.dependency "ExpoModulesCore"
  s.frameworks = "CloudKit"
  s.swift_version = "5.9"
  s.source_files = "ios/**/*.{h,m,mm,swift}"
end
