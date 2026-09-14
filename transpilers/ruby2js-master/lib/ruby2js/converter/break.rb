module Ruby2JS
  class Converter

    # (break
    #   (int 1))

    handle :break do |n=nil|
      raise Error.new("break argument #{ n.inspect }", @ast) if n
      if @next_token == :return
        return put('return') if @loose_break
        raise Error.new("break outside of loop", @ast)
      end
      put 'break'
    end
  end
end
