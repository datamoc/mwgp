create_file Rails.root.join('config/initializers/ruby2js.rb').to_s,
  <<~CONFIG
    require 'stimulus/manifest'

    module Stimulus::Manifest
      def import_and_register_controller(controllers_path, controller_path)
        controller_path = controller_path.relative_path_from(controllers_path).to_s
        module_path = controller_path.split('.').first
        controller_class_name = module_path.camelize.gsub(/::/, "__")
        tag_name = module_path.remove(/_controller/).gsub(/_/, "-").gsub(/\//, "--")

        <<~JS

          import #{controller_class_name} from "./#{controller_path}"
          application.register("#{tag_name}", #{controller_class_name})
        JS
      end

      def extract_controllers_from(directory)
        (directory.children.select { |e| e.to_s =~ /_controller\.js(\.\w+)?$/ } +
          directory.children.select(&:directory?).collect { |d| extract_controllers_from(d) }
        ).flatten.sort
      end
    end
  CONFIG
