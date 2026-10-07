# Used only by the demo recording (docs/demo/demo.tape). It adds line breaks and nothing else:
# a line longer than w characters is broken at a space, or, when it has no space to break at
# (a file path, a link), at w characters. Every character the tool prints is kept in order.
{
  while (length($0) > w) {
    i = w
    while (i > 3 && substr($0, i, 1) != " " && substr($0, i + 1, 1) != " ") i--
    if (i <= 3) i = w
    print substr($0, 1, i)
    $0 = substr($0, i + 1)
    sub(/^ /, "", $0)
  }
  print
}
