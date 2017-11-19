bash -c 'for image in *.png; do convert "$image" -resize x60 "../logos/$image" ; echo “image $image converted to ${image%.jpg}.png ”; done'
