# Kinda like Object.assign, except it handles properties
#
# Note: Object.defineProperties, Object.getOwnPropertyNames, etc. technically
#   were not part of ES5, but were implemented by IE prior to ES6, and are
#   the only way to implement getters and setters.

module Ruby2JS
  class Converter

   # (assign
   #   target
   #   (hash)
   #   ...

    handle :assign do |target, *args|
      collapsible = false

      nonprop = proc do |node|
        next false unless ast_node?(node)
        next false if node.type == :pair and node.children.first.type == :prop
        next true unless node.type == :def
        next false if node.children.first.to_s.end_with? '='
        node.is_method?
      end

      collapsible = true if args.length == 1 and args.first.type == :hash and
        args.first.children.length == 1

      collapsible = true if args.length == 1 and args.first.type == :class_module and
        args.first.children.length == 3 and nonprop.call(args.first.children.last)

      # Check if target is a prototype (include/extend uses X.prototype as target)
      # Prototype assignments need defineProperties to copy getters without invoking them
      is_prototype_target = target.type == :attr && target.children[1] == :prototype

      if not collapsible and not is_prototype_target and args.all? {|arg|
          case arg.type
          when :pair, :hash, :class_module
            arg.children.all? {|child| nonprop.call(child)}
          when :const
            # Constants (module/class names) may have getters, so we need
            # Object.defineProperties to copy them without invoking the getters.
            # This is important for Ruby's include/extend which copy module methods.
            false
          else
            true
          end
        }
        parse s(:send, s(:const, nil, :Object), :assign, target, *args)
      else

        if target == s(:hash)
          copy = [s(:gvasgn, :$$, target)]
          target = s(:gvar, :$$)
          shadow = [s(:shadowarg, :$$)]
        elsif collapsible or
          (%i(send const).include? target.type and
          target.children.length == 2 and target.children[0] == nil) or
          (target.type == :attr and target.children.length == 2)
        then
          copy = []
          shadow = []
        else
          copy = [s(:gvasgn, :$0, target)]
          target = s(:gvar, :$0)
          shadow = [s(:shadowarg, :$0)]
        end

        body = [*copy,
          *args.map {|modname|
            if modname.type == :hash and
              modname.children.all? {|pair| pair.children.first.type == :prop}

              if modname.children.length == 1
                pair = modname.children.first
                s(:send, s(:const, nil, :Object), :defineProperty, target,
                  s(:sym, pair.children.first.children.last),
                  s(:hash, *pair.children.last.map {|entry| s(:pair, # Pragma: entries
                  s(:sym, entry[0]), entry[1])}))
              else
                pair = modname.children.first
                s(:send, s(:const, nil, :Object), :defineProperties, target,
                  s(:hash, *modname.children.map {|pair| s(:pair,
                    s(:sym, pair.children.first.children.last),
                    s(:hash, *pair.children.last.map {|entry| s(:pair, # Pragma: entries
                    s(:sym, entry[0]), entry[1])})
                  )}))
              end

            elsif modname.type == :hash and
              modname.children.all? {|child| nonprop.call(child)}

              s(:begin, *modname.children.map {|pair|
                if pair.children.first.type == :prop
                  s(:send, s(:const, nil, :Object), :defineProperty, target,
                    s(:sym, pair.children.first.children.last),
                    s(:hash, *pair.children.last.map {|entry| s(:pair, # Pragma: entries
                    s(:sym, entry[0]), entry[1])}))
                else
                  s(:send, target, :[]=, *pair.children)
                end
              })

            elsif modname.type == :class_module and
              modname.children[2..-1].all? {|child| nonprop.call(child)}

              s(:begin, *modname.children[2..-1].map {|pair|
                  if %i(class module).include? pair.type
                    # A reopened module whose body is (partly) a nested class/module
                    # declaration rather than just methods - e.g. `module A; class B;
                    # ...; end; end` reopening `module A`. `pair.children.first` here is
                    # the class/module's own name node, not a method symbol; attach it
                    # as a named property instead of wrapping that node inside `:sym`.
                    #
                    # `pair`'s own name is still just `B` (unqualified) at this point, not
                    # `A::B` - left alone, parsing `pair` as-is re-enters `A`'s namespace
                    # scope under an unqualified key, so it won't be recognized as
                    # reopening the SAME `B` a bare `class A::B` elsewhere resolves to, and
                    # everything inside it ends up qualified as bare `B` rather than `A.B`.
                    # Qualify it against `target` (here, `A`) and let the class converter's
                    # own (already-correct, and used everywhere else) compound-const
                    # handling emit the declaration/reopening-assignment itself - wrapping
                    # it in another assignment here would double up with the self-assigning
                    # output it already produces for a reopened class.
                    class_name = pair.children.first.children.last
                    qualified_name = pair.children.first.updated(nil, [target, class_name])
                    pair.updated(nil, [qualified_name, *pair.children[1..-1]])
                  else
                    s(:send, target, :[]=, s(:sym, pair.children.first),
                    pair.updated(:defm, [nil, *pair.children[1..-1]]))
                  end
                })

            else
              s(:send, s(:const, nil, :Object), :defineProperties, target,
                s(:send, s(:const, nil, :Object), :getOwnPropertyDescriptors, modname))
            end
          }]

        if @state == :statement and shadow.empty?
          parse s(:begin, *body)
        else
          body.push s(:return, target) if @state == :expression
          parse s(:send, s(:block, s(:send, nil, :lambda), s(:args, *shadow),
            s(:begin, *body)), :[])
        end
      end
    end
  end
end
