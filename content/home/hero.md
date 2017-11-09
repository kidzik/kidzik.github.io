+++
# Hero widget.
widget = "hero"
active = true
date = 2017-10-15

title = "Mathematician"

# Order that this section will appear in.
weight = 3

# Overlay a color or image (optional).
#   Deactivate an option by commenting out the line, prefixing it with `#`.
[header]
  overlay_color = "#00F"  # An HTML color value.
  overlay_img = "bg.jpg"  # Image path relative to your `static/img/` folder.
  overlay_filter = 0.6  # Darken the image. Value in range 0-1.

# Call to action button (optional).
#   Activate the button by specifying a URL and button label below.
#   Deactivate by commenting out parameters, prefixing lines with `#`.
[cta]
  url = "http://kidzinski.com/Lukasz-Kidzinski-CV.pdf"
  label = '<i class="fa fa-download"></i> Download my latest CV'
+++

Designing new tools for [high-dimensional time series](https://cran.r-project.org/web/packages/freqdom/index.html). <br> Applying deep reinforcement learning in [biomechanics](http://github.com/stanfordnmbl/osim-rl) and computer vision in [movement analysis](https://www.youtube.com/watch?v=SjPP5x1csOc). <br> A co-founder of [DeepArt](https://deepart.io/) - the neural style transfer company. <br>Constantly looking for new opportunities and challenges
:rocket:
<br>
<!--br>
<small><a id="academic-release" href="https://sourcethemes.com/academic/tags/updates">Latest release</a></small>
<br><br>
<iframe style="display: inline-block;" src="https://ghbtns.com/github-btn.html?user=gcushen&amp;repo=hugo-academic&amp;type=star&amp;count=true&amp;size=large" scrolling="0" width="160px" height="30px" frameborder="0"></iframe>
<iframe style="display: inline-block;" src="https://ghbtns.com/github-btn.html?user=gcushen&amp;repo=hugo-academic&amp;type=fork&amp;count=true&amp;size=large" scrolling="0" width="158px" height="30px" frameborder="0"></iframe-->

<script type="text/javascript">
  (function defer() {
    if (window.jQuery) {
      jQuery(document).ready(function(){
        GetLatestReleaseInfo();
      });
    } else {
      setTimeout(function() { defer() }, 50);
    }
  })();  
  function GetLatestReleaseInfo() {
    $.getJSON('https://api.github.com/repos/gcushen/hugo-academic/tags').done(function (json) {
      let release = json[0];
      // let downloadURL = release.zipball_url;
      $('#academic-release').text('Latest release ');  
    });    
}  
</script>
