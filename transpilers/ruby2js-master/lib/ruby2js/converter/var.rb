module Ruby2JS
  class Converter

    # (lvar :a)
    # (gvar :$a)

    # A handful of Ruby's special global variables are punctuation JS identifiers can't
    # spell at all ($~, $&, $', $`, ...); map the common regexp-match ones to distinct
    # names known not to collide with real code. `=~` compiles to a boolean `.test()|`,
    # not a MatchData-populating operation, so none of these carry real last-match state
    # here regardless of spelling - this only keeps such code syntactically valid, not
    # semantically equivalent to Ruby's, and existing code shouldn't rely on it.
    SPECIAL_GVARS = { :"$~" => '$MATCH', :"$&" => '$MATCH0', :"$'" => '$POSTMATCH', :"$`" => '$PREMATCH' }

    handle :lvar, :gvar do |var|
      if var == :$!
        put '$EXCEPTION'
      elsif @ast.type == :lvar
        put jsvar(var)
      elsif SPECIAL_GVARS[var]
        put SPECIAL_GVARS[var]
      elsif var.to_s =~ /\A\$\w+\z/
        put var
      else
        put "$g#{var.to_s.gsub(/\W/, '')}"
      end
    end
  end
end
