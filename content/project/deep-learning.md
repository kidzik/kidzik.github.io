+++
# Date this page was created.
date = "2016-04-27"

# Project title.
title = "Learning how to walk"

# Project summary to display on homepage.
summary = "Neuromuscular virtual environments to better understand human movement"

# Optional image to display on homepage (relative to `static/img/` folder).
image_preview = "headers/l2r.jpg"

# Tags: can be used for filtering projects.
# Example: `tags = ["machine-learning", "deep-learning"]`
tags = ["deep-learning","reinforcement-learning","biomechanics"]

# Optional external URL for project (replaces project detail page).
external_link = ""

# Does the project detail page use math formatting?
math = false

# Optional featured image (relative to `static/img/` folder).
[header]
image = "headers/l2r.jpg"
caption = "My caption :smile:"

+++

Human movement results from the intricate coordination of muscles, tendons, joints, and other physiological elements. While children learn to walk, run, climb, and jump in their first years of life and most of us can navigate complex environments--like a crowded street or moving subway--without considerable active attention, developing controllers that can efficiently and robustly synthesize realistic human motions in a variety of environments remains a grand challenge for biomechanists, neuroscientists, and computer scientists. Current controllers are confined to a small set of pre-specified movements or driven by torques, rather than the complex muscle actuators found in humans.

To solve these research problems, we created a virtual physiologically accurate musucluskeletal environment in OpenSim software and we set up [a competition to build models of the brain](https://www.crowdai.org/challenges/nips-2017-learning-to-run). Competition was accepted as one of the 5 official competitions at NIPS 2017. Here is one of the solutions.

{{< youtube mbjuaRg__DI >}}
<br>
You can find the code on [github](http://github.com/stanfordnmbl/osim-rl).
